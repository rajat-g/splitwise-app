const dbName = "splitwiseDB";
let db;

// Open (or create) the database
const request = indexedDB.open(dbName, 2); // Increased version number

request.onupgradeneeded = (event) => {
    db = event.target.result;
    const expenseStore = db.createObjectStore("expenses", { keyPath: "id", autoIncrement: true });
    expenseStore.createIndex("name", "name", { unique: false });
    expenseStore.createIndex("amount", "amount", { unique: false });
    expenseStore.createIndex("personId", "personId", { unique: false });
    expenseStore.createIndex("splitWith", "splitWith", { unique: false });
    expenseStore.createIndex("splitType", "splitType", { unique: false });
    expenseStore.createIndex("splitDetails", "splitDetails", { unique: false });

    const personStore = db.createObjectStore("persons", { keyPath: "id", autoIncrement: true });
    personStore.createIndex("name", "name", { unique: true });
};

request.onsuccess = (event) => {
    db = event.target.result;
    loadPersons();
    loadExpenses();
};

function addPerson(name) {
    const transaction = db.transaction(["persons"], "readwrite");
    const objectStore = transaction.objectStore("persons");
    objectStore.add({ name });
    transaction.oncomplete = loadPersons;
}

function loadPersons() {
    const transaction = db.transaction(["persons"], "readonly");
    const objectStore = transaction.objectStore("persons");
    const request = objectStore.getAll();

    request.onsuccess = (event) => {
        const persons = event.target.result;
        $("#person-select").empty();
        $("#split-with").empty();
        persons.forEach(person => {
            $("#person-select").append(`<option value="${person.id}">${person.name}</option>`);
            $("#split-with").append(`<option value="${person.id}">${person.name}</option>`);
        });
    };
}

function calculateSplitAmounts(totalAmount, splitType, splitDetails, splitWith, personId) {
    const amounts = {};

    switch (splitType) {
        case 'equal':
            const totalPeople = splitWith.length;
            const sharePerPerson = totalAmount / totalPeople;
            
            splitWith.forEach(id => {
                amounts[id] = sharePerPerson;
            });
            break;

        case 'exact':
            splitWith.forEach((id, index) => {
                amounts[id] = parseFloat(splitDetails[index]);
            });
            break;

        case 'percentage':
            splitWith.forEach((id, index) => {
                amounts[id] = (totalAmount * parseFloat(splitDetails[index])) / 100;
            });
            break;
			
		case 'shares':
            const totalShares = splitDetails.reduce((sum, share) => sum + parseFloat(share), 0);
            const perShare = totalAmount / totalShares;
            
            splitWith.forEach((id, index) => {
                amounts[id] = perShare * parseFloat(splitDetails[index]);
            });
            break;
    }

    return amounts;
}

function addExpense(name, amount, personId, splitWith, splitType, splitDetails) {
    const transaction = db.transaction(["expenses"], "readwrite");
    const objectStore = transaction.objectStore("expenses");
    objectStore.add({
        name,
        amount,
        personId,
        splitWith,
        splitType,
        splitDetails
    });

    transaction.oncomplete = loadExpenses;
}

function loadExpenses() {
    const transaction = db.transaction(["expenses", "persons"], "readonly");
    const expenseStore = transaction.objectStore("expenses");
    const personStore = transaction.objectStore("persons");
    const request = expenseStore.getAll();

    request.onsuccess = async (event) => {
        const expenses = event.target.result;
        const balances = {}; // Track overall balances
        const owingDetails = {}; // Track person-to-person debts
        $("#expense-list").empty();

        // First calculate all expenses and balances
        for (const expense of expenses) {
            // Get payer and splitWith names
            const payer = await getPersonName(expense.personId);
            const splitWithNames = await Promise.all(expense.splitWith.map(id => getPersonName(id)));

            let splitDetailsStr = '';
			// Get all persons from the DB to check if all are involved
			const allPersons = await new Promise((resolve) => {
				const transaction = db.transaction(["persons"], "readonly");
				const objectStore = transaction.objectStore("persons");
				const req = objectStore.getAll();
				req.onsuccess = (event) => resolve(event.target.result);
			});
            switch (expense.splitType) {
                case 'equal':
					if(expense.splitWith.length === allPersons.length) {
						splitDetailsStr = 'Split equally';
					} else {
						splitDetailsStr = `Split equally between: ${expense.splitWith.map((amount, i) =>
                        `${splitWithNames[i]}`).join(', ')}`;
					}
                    break;
                case 'exact':
                    splitDetailsStr = `Split exactly: ${expense.splitDetails.map((amount, i) =>
                        `${splitWithNames[i]}: ₹${amount}`).join(', ')}`;
                    break;
                case 'percentage':
                    splitDetailsStr = `Split by percentage: ${expense.splitDetails.map((percent, i) =>
                        `${splitWithNames[i]}: ${percent}%`).join(', ')}`;
                    break;
                case 'shares':
					const allPersonIds = allPersons.map(person => person.id.toString());
					// Check if the expense involves all persons in the DB
					const allInvolved = (expense.splitWith.length === allPersonIds.length) &&
										allPersonIds.every(id => expense.splitWith.includes(id));
					
					if (allInvolved) {
						// Check if everyone has the same share
						const shares = expense.splitDetails.map(s => parseFloat(s));
						const firstShare = shares[0];
						const allSame = shares.every(s => Math.abs(s - firstShare) < 0.001);
						if (allSame) {
							splitDetailsStr = "Split Equally";
						} else {
							splitDetailsStr = `Split by shares: ${expense.splitDetails.map((share, i) =>
								`${splitWithNames[i]}: ${share} shares`).join(', ')}`;
						}
					} else {
						splitDetailsStr = `Split by shares: ${expense.splitDetails.map((share, i) =>
							`${splitWithNames[i]}: ${share} shares`).join(', ')}`;
					}
					break;

            }

            // Append expense with enhanced labels and a delete button
            $("#expense-list").append(
                `<li class="expense-item">
                    <div class="expense-info">
                        <div class="expense-name">${expense.name}</div>
                        <div class="expense-amount">Total: ₹${expense.amount}</div>
                        <div class="expense-paid-by">Paid by: ${payer}</div>
                        <div class="expense-split">${splitDetailsStr}</div>
                    </div>
                    <button class="delete-expense danger-button" onclick="deleteExpense(${expense.id});">Delete</button>
                </li>`
            );

            // Calculate how much each person should pay and update balances
            const splitAmounts = calculateSplitAmounts(
                parseFloat(expense.amount),
                expense.splitType,
                expense.splitDetails,
                expense.splitWith,
                expense.personId
            );

            // Update overall balances
            if (!balances[expense.personId]) balances[expense.personId] = 0;
            balances[expense.personId] += parseFloat(expense.amount);

            // Update individual split amounts
            Object.entries(splitAmounts).forEach(([personId, amount]) => {
                if (!balances[personId]) balances[personId] = 0;
                balances[personId] -= amount;

                // Track who owes whom
                const key = `${personId}-${expense.personId}`;
                if (!owingDetails[key]) owingDetails[key] = 0;
                owingDetails[key] += amount;
            });
        }

        // Display balances
        $("#owes-list").empty();

        // Show detailed person-to-person owings
        const processedPairs = new Set();

        for (const [pairKey, amount] of Object.entries(owingDetails)) {
            if (amount === 0) continue;

            const [person1Id, person2Id] = pairKey.split('-');
            const reversePairKey = `${person2Id}-${person1Id}`;

            // Skip if we've already processed this pair
            if (processedPairs.has(pairKey) || processedPairs.has(reversePairKey)) {
                continue;
            }
            processedPairs.add(pairKey);
            processedPairs.add(reversePairKey);

            const person1Name = await getPersonName(parseInt(person1Id));
            const person2Name = await getPersonName(parseInt(person2Id));

            const reverseAmount = owingDetails[reversePairKey] || 0;
            const netAmount = amount - reverseAmount;

            if (Math.abs(netAmount) < 0.01) continue; // Skip if net amount is negligible

            let displayText, amountClass;
            if (netAmount > 0) {
                displayText = `${person1Name} owes ${person2Name}`;
                amountClass = 'owes';
            } else {
                displayText = `${person2Name} owes ${person1Name}`;
                amountClass = 'owes';
            }

            $("#owes-list").append(`
                <li class="balance-item ${amountClass}">
                    <div class="balance-details">
                        <div class="balance-name">${displayText}</div>
                    </div>
                    <div class="balance-amount">
                        ₹${Math.abs(netAmount).toFixed(2)}
                    </div>
                </li>
            `);
        }
    };
}

async function getPersonName(id) {
    return new Promise((resolve) => {
        const transaction = db.transaction(["persons"], "readonly");
        const objectStore = transaction.objectStore("persons");
        const request = objectStore.get(parseInt(id));
        request.onsuccess = (event) => {
            resolve(event.target.result?.name || `Person ${id}`);
        };
    });
}

// Form submission handlers and UI setup
$(document).ready(() => {

    // Add this new handler for person-select changes
    $("#person-select").change(function () {
        $("#split-type").trigger('change');
    });

    // Add this handler for split-type changes
    $("#split-type").change(async function () {
        const splitType = $(this).val();
        const selectedPeople = $("#split-with").val();
        const selectedPayer = $("#person-select").val();
		
    $("#split-details-container").empty();

        $("#split-details-container").empty();

        if (splitType !== 'equal' && selectedPeople.length > 0) {
            // Get names for all selected people
            const detailsHtml = await Promise.all(selectedPeople.map(async personId => {
                const personName = await getPersonName(parseInt(personId));
				const placeholder = splitType === 'percentage' ? 'Percentage' :
                              splitType === 'shares' ? 'Shares' : 'Amount';
				const symbol = splitType === 'percentage' ? '%' :
                           splitType === 'shares' ? 'shares' : '₹';
                return `
                    <div class="split-detail">
                        <label>${personName}:</label>
                        <input type="number" 
                               class="split-detail-input" 
                               data-person="${personId}" 
                               step="${splitType === 'percentage' ? '0.01' : '1'}"
                               required 
                               placeholder="${placeholder}"
							   min="0"
							   ${splitType === 'percentage' ? 'max="100"' : ''}
                        >
                        ${symbol}
                    </div>
                `;
            }));

            $("#split-details-container").html(detailsHtml.join(''));
        }
    });

    // Update split details when people selection changes
    $("#split-with").change(function () {
        $("#split-type").trigger('change');
    });

    $("#person-form").submit(function (event) {
        event.preventDefault();
        const name = $("#person-name").val();
        addPerson(name);
        $("#person-name").val('');
    });

    $("#expense-form").submit(function (event) {
        event.preventDefault();
        const name = $("#expense-name").val();
        const amount = parseFloat($("#amount").val());
        const personId = $("#person-select").val();
        const splitWith = Array.from($("#split-with").val());
        const splitType = $("#split-type").val();

        let splitDetails = [];
        if (splitType !== 'equal') {
            splitDetails = Array.from($(".split-detail-input")).map(input => $(input).val());
			
			if (splitType === 'shares') {
				const shares = splitDetails.map(s => parseFloat(s));
				if (shares.some(s => s <= 0)) {
					alert("Shares must be positive numbers!");
					return;
				}
				const totalShares = shares.reduce((a, b) => a + b, 0);
				if (totalShares <= 0) {
					alert("Total shares must be greater than zero!");
					return;
				}
			}

            // Validate total for exact amounts
            if (splitType === 'exact') {
                const totalSplit = splitDetails.reduce((sum, val) => sum + parseFloat(val), 0);
                if (Math.abs(totalSplit - amount) > 0.01) {
                    alert("The sum of split amounts must equal the total amount!");
                    return;
                }
            }

            // Validate percentages
            if (splitType === 'percentage') {
                const totalPercentage = splitDetails.reduce((sum, val) => sum + parseFloat(val), 0);
                if (Math.abs(totalPercentage - 100) > 0.01) {
                    alert("Percentages must sum to 100!");
                    return;
                }
            }
        }

        addExpense(name, amount, personId, splitWith, splitType, splitDetails);

        // Reset form
        $("#expense-name").val('');
        $("#amount").val('');
        $("#split-with").val([]);
        $("#split-type").val('equal');
        $("#split-details-container").empty();
    });

	$("#simplify-debts").click(function() {
        simplifyDebtsHandler();
    });
});

// Function to delete an expense from the database
function deleteExpense(expenseId) {
    const transaction = db.transaction(["expenses"], "readwrite");
    const expenseStore = transaction.objectStore("expenses");
    expenseStore.delete(expenseId);
    transaction.oncomplete = loadExpenses;
    transaction.onerror = () => {
        alert("Error deleting the expense!");
    };
}

// Add this function to clear the database
function clearDatabase() {
    if (!confirm("Are you sure you want to clear all data? This cannot be undone.")) {
        return;
    }

    const transaction = db.transaction(["expenses", "persons"], "readwrite");
    const expenseStore = transaction.objectStore("expenses");
    const personStore = transaction.objectStore("persons");

    // Clear both object stores
    expenseStore.clear();
    personStore.clear();

    transaction.oncomplete = () => {
        // Refresh the UI
        $("#expense-list").empty();
        $("#owes-list").empty();
        $("#person-select").empty();
        $("#split-with").empty();
        $("#split-details-container").empty();

        alert("All data has been cleared successfully!");
    };

    transaction.onerror = () => {
        alert("Error clearing the database!");
    };
}

// Function to simplify debts using net balances
function simplifyDebts(balances) {
    // Convert the balances object into an array of { id, balance } objects,
    // filtering out negligible values.
    let persons = [];
    for (const id in balances) {
        if (Math.abs(balances[id]) > 0.01) {
            persons.push({ id: id, balance: balances[id] });
        }
    }

    // Separate creditors (positive balance) and debtors (negative balance)
    let creditors = persons.filter(p => p.balance > 0).sort((a, b) => b.balance - a.balance);
    let debtors = persons.filter(p => p.balance < 0).sort((a, b) => a.balance - b.balance);

    let transactions = [];
    // Greedy settlement: match the largest creditor with the largest debtor
    while (creditors.length > 0 && debtors.length > 0) {
        let creditor = creditors[0];
        let debtor = debtors[0];
        let amount = Math.min(creditor.balance, -debtor.balance);
        transactions.push({ from: debtor.id, to: creditor.id, amount: amount });

        // Update balances after settlement
        creditor.balance -= amount;
        debtor.balance += amount; // debtor.balance is negative

        // Remove settled creditors or debtors
        if (Math.abs(creditor.balance) < 0.01) {
            creditors.shift();
        }
        if (Math.abs(debtor.balance) < 0.01) {
            debtors.shift();
        }
    }
    return transactions;
}

// Handler to compute net balances from expenses, simplify them, and display simplified transactions
async function simplifyDebtsHandler() {
    // Open a transaction to get all expenses from the database.
    const transaction = db.transaction(["expenses"], "readonly");
    const expenseStore = transaction.objectStore("expenses");
    const request = expenseStore.getAll();

    request.onsuccess = async (event) => {
        const expenses = event.target.result;
        let balances = {};

        // Compute net balances for each person
        for (const expense of expenses) {
            // The person who paid gets a positive balance
            if (!balances[expense.personId]) balances[expense.personId] = 0;
            balances[expense.personId] += parseFloat(expense.amount);

            // Calculate how much each person should pay based on the expense’s split details.
            const splitAmounts = calculateSplitAmounts(
                parseFloat(expense.amount),
                expense.splitType,
                expense.splitDetails,
                expense.splitWith,
                expense.personId
            );

            // Each person involved (except the payer) gets a negative balance.
            Object.entries(splitAmounts).forEach(([personId, amount]) => {
                if (!balances[personId]) balances[personId] = 0;
                balances[personId] -= amount;
            });
        }

        // Use the simplifyDebts function to get a list of transactions.
        const simplifiedTransactions = simplifyDebts(balances);

        // Clear any existing simplified transactions in the UI.
        $("#simplified-owes-list").empty();

        // For each simplified transaction, get the person names and display the transaction.
        for (const txn of simplifiedTransactions) {
            const fromName = await getPersonName(parseInt(txn.from));
            const toName = await getPersonName(parseInt(txn.to));
            $("#simplified-owes-list").append(`
                <li class="balance-item">
                    <div class="balance-details">
                        <div class="balance-name">${fromName} pays ${toName}</div>
                    </div>
                    <div class="balance-amount">
                        ₹${txn.amount.toFixed(2)}
                    </div>
                </li>
            `);
        }
    };

    request.onerror = () => {
        alert("Error retrieving expenses for debt simplification.");
    };
}