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

function calculateSplitAmounts(totalAmount, splitType, splitDetails, splitWith) {
    const amounts = {};
    
    switch(splitType) {
        case 'equal':
            // Each person's share (excluding the payer)
            const sharePerPerson = totalAmount / (splitWith.length + 1);
            
            // Calculate what each person owes
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
            // Display expense in the expense list
            const payer = await getPersonName(expense.personId);
            const splitWithNames = await Promise.all(expense.splitWith.map(id => getPersonName(id)));
            
            let splitDetailsStr = '';
            switch(expense.splitType) {
                case 'equal':
                    splitDetailsStr = 'Split equally';
                    break;
                case 'exact':
                    splitDetailsStr = `Split exactly: ${expense.splitDetails.map((amount, i) => 
                        `${splitWithNames[i]}: $${amount}`).join(', ')}`;
                    break;
                case 'percentage':
                    splitDetailsStr = `Split by percentage: ${expense.splitDetails.map((percent, i) => 
                        `${splitWithNames[i]}: ${percent}%`).join(', ')}`;
                    break;
            }

            $("#expense-list").append(
                `<li class="expense-item">
                    <div class="expense-name">${expense.name}</div>
                    <div class="expense-details">
                        Total: ₹${expense.amount}<br>
                        Paid by: ${payer}<br>
                        ${splitDetailsStr}
                    </div>
                </li>`
            );

            const splitAmounts = calculateSplitAmounts(
                parseFloat(expense.amount),
                expense.splitType,
                expense.splitDetails,
                expense.splitWith
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

            if (Math.abs(netAmount) < 0.01) continue; // Skip if the net amount is effectively zero

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

    // Handle split type changes
    $("#split-type").change(async function() {
        const splitType = $(this).val();
        const selectedPeople = $("#split-with").val();
        
        $("#split-details-container").empty();
        
        if (splitType !== 'equal' && selectedPeople.length > 0) {
            // Get names for all selected people
            const detailsHtml = await Promise.all(selectedPeople.map(async personId => {
                const personName = await getPersonName(parseInt(personId));
                return `
                    <div class="split-detail">
                        <label>${personName}:</label>
                        <input type="number" 
                               class="split-detail-input" 
                               data-person="${personId}" 
                               step="0.01" 
                               required 
                               placeholder="${splitType === 'percentage' ? 'Percentage' : 'Amount'}"
                        >
                        ${splitType === 'percentage' ? '%' : '₹'}
                    </div>
                `;
            }));
            
            $("#split-details-container").html(detailsHtml.join(''));
        }
    });

    // Update split details when people selection changes
    $("#split-with").change(function() {
        $("#split-type").trigger('change');
    });

    $("#person-form").submit(function(event) {
        event.preventDefault();
        const name = $("#person-name").val();
        addPerson(name);
        $("#person-name").val('');
    });

    $("#expense-form").submit(function(event) {
        event.preventDefault();
        const name = $("#expense-name").val();
        const amount = parseFloat($("#amount").val());
        const personId = $("#person-select").val();
        const splitWith = Array.from($("#split-with").val());
        const splitType = $("#split-type").val();
        
        let splitDetails = [];
        if (splitType !== 'equal') {
            splitDetails = Array.from($(".split-detail-input")).map(input => $(input).val());
            
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
});


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