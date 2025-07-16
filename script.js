const dbName = "splitwiseDB";
    let db;
    const MAX_URL_LENGTH = 2000;
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
        // On page load, check for data param
        const params = new URLSearchParams(window.location.search);
        if (params.has('data')) {
            const compressed = params.get('data');
            const json = LZString.decompressFromEncodedURIComponent(compressed);
            if (!json) {
                alert('Invalid shared data.');
            } else {
                if (confirm('This will clear existing data and load shared data. Continue?')) {
                    const parsed = JSON.parse(json);
                    loadIntoIndexedDB(parsed);
                    // Use history.replaceState to clean the URL without reloading
                    window.history.replaceState({}, document.title, window.location.pathname);
                }
            }
        }
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
            if (persons.length === 0) {
                $("#person-select").append(`<option disabled selected>Add a person first</option>`);
            }
            persons.forEach(person => {
                $("#person-select").append(`<option value="${person.id}">${person.name}</option>`);
                $("#split-with").append(`<option value="${person.id}">${person.name}</option>`);
            });
            updatePersonSharesList();
        };
    }

    function calculateSplitAmounts(totalAmount, splitType, splitDetails, splitWith, personId) {
        const amounts = {};

        switch (splitType) {
            case 'equal':
                const totalPeople = splitWith.length;
                if (totalPeople === 0) return {};
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
                if (totalShares === 0) return {};
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
        const request = expenseStore.getAll();

        request.onsuccess = async (event) => {
            const expenses = event.target.result;
            const balances = {}; 
            const owingDetails = {};
            $("#expense-list").empty();

            if (expenses.length === 0) {
                $("#expense-list").html(`<div class="text-center text-gray-500 py-10">
                    <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <h3 class="mt-2 text-sm font-medium text-gray-900">No expenses yet</h3>
                    <p class="mt-1 text-sm text-gray-500">Get started by adding an expense.</p>
                  </div>`);
            }

            for (const expense of expenses) {
                const payer = await getPersonName(expense.personId);
                const splitWithNames = await Promise.all(expense.splitWith.map(id => getPersonName(id)));

                let splitDetailsStr = '';
                const allPersons = await new Promise((resolve) => {
                    const transaction = db.transaction(["persons"], "readonly");
                    const objectStore = transaction.objectStore("persons");
                    const req = objectStore.getAll();
                    req.onsuccess = (event) => resolve(event.target.result);
                });
                switch (expense.splitType) {
                    case 'equal':
                        splitDetailsStr = `Split equally between: ${expense.splitWith.map((amount, i) =>
                            `${splitWithNames[i]}`).join(', ')}`;
                        break;
                    case 'exact':
                        splitDetailsStr = `Split by exact amounts: ${expense.splitDetails.map((amount, i) => `${splitWithNames[i]}: ₹${amount}`).join(', ')}`;
                        break;
                    case 'percentage':
                        splitDetailsStr = `Split by percentage: ${expense.splitDetails.map((percent, i) => `${splitWithNames[i]}: ${percent}%`).join(', ')}`;
                        break;
                    case 'shares':
                        splitDetailsStr = `Split by shares: ${expense.splitDetails.map((share, i) => `${splitWithNames[i]}: ${share} shares`).join(', ')}`;
                        break;
                }

                $("#expense-list").append(
                    `<li class="expense-item">
                        <div class="flex-grow">
                            <div class="font-bold text-lg text-gray-800">${expense.name}</div>
                            <div class="text-sm text-gray-500">${splitDetailsStr}</div>
                            <div class="text-sm text-gray-500 mt-1">Paid by: <span class="font-semibold text-gray-700">${payer}</span></div>
                        </div>
                        <div class="text-right">
                           <div class="font-bold text-xl text-black-600">₹${parseFloat(expense.amount).toFixed(2)}</div>
                           
						   <button class="delete-expense text-red-400 hover:text-red-600 p-2 rounded-full hover:bg-red-100 transition-all" onclick="deleteExpense(${expense.id});" title="Delete Expense">
                                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                           </button>
                        </div>
                    </li>`
                );

                const splitAmounts = calculateSplitAmounts(
                    parseFloat(expense.amount),
                    expense.splitType,
                    expense.splitDetails,
                    expense.splitWith,
                    expense.personId
                );

                if (!balances[expense.personId]) balances[expense.personId] = 0;
                balances[expense.personId] += parseFloat(expense.amount);

                Object.entries(splitAmounts).forEach(([personId, amount]) => {
                    if (!balances[personId]) balances[personId] = 0;
                    balances[personId] -= amount;

                    const key = `${personId}-${expense.personId}`;
                    if (!owingDetails[key]) owingDetails[key] = 0;
                    owingDetails[key] += amount;
                });
            }

            $("#owes-list").empty();
            if (Object.keys(owingDetails).length === 0) {
                 $("#owes-list").html(`<div class="text-center text-gray-500 py-10">
                    <svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v.01" />
                    </svg>
                    <h3 class="mt-2 text-sm font-medium text-gray-900">No balances to show</h3>
                    <p class="mt-1 text-sm text-gray-500">All settled up, or no expenses added yet.</p>
                  </div>`);
            }
            const processedPairs = new Set();

            for (const [pairKey, amount] of Object.entries(owingDetails)) {
                if (amount === 0) continue;

                const [person1Id, person2Id] = pairKey.split('-');
                const reversePairKey = `${person2Id}-${person1Id}`;

                if (processedPairs.has(pairKey) || processedPairs.has(reversePairKey)) {
                    continue;
                }
                processedPairs.add(pairKey);
                processedPairs.add(reversePairKey);

                const person1Name = await getPersonName(parseInt(person1Id));
                const person2Name = await getPersonName(parseInt(person2Id));

                const reverseAmount = owingDetails[reversePairKey] || 0;
                const netAmount = amount - reverseAmount;

                if (Math.abs(netAmount) < 0.01) continue;

                let displayText;
                if (netAmount > 0) {
                    displayText = `<span class="font-semibold">${person1Name}</span> owes <span class="font-semibold">${person2Name}</span>`;
                } else {
                    displayText = `<span class="font-semibold">${person2Name}</span> owes <span class="font-semibold">${person1Name}</span>`;
                }

                $("#owes-list").append(`
                    <li class="balance-item owes">
                        <div class="balance-details">${displayText}</div>
                        <div class="balance-amount font-bold text-lg">
                            ₹${Math.abs(netAmount).toFixed(2)}
                        </div>
                    </li>
                `);
            }
            updatePersonSharesList();
			simplifyDebtsHandler();
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

    $(document).ready(() => {
        $("#person-select, #split-with, #split-type").change(async function () {
            const splitType = $("#split-type").val();
            const selectedPeople = $("#split-with").val();
            $("#split-details-container").empty();

            if (splitType !== 'equal' && selectedPeople && selectedPeople.length > 0) {
                const detailsHtml = await Promise.all(selectedPeople.map(async personId => {
                    const personName = await getPersonName(parseInt(personId));
                    const placeholder = splitType === 'percentage' ? 'Percent' : splitType === 'shares' ? 'Shares' : 'Amount';
                    const symbol = splitType === 'percentage' ? '%' : splitType === 'shares' ? '' : '₹';
                    return `
                        <div class="split-detail flex items-center gap-3">
                            <label class="w-1/3 text-sm text-gray-600">${personName}:</label>
                            <div class="flex-grow flex items-center">
                                ${symbol === '₹' ? `<span class="text-gray-500 mr-2">${symbol}</span>` : ''}
                                <input type="number" class="split-detail-input bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2" data-person="${personId}" step="0.01" required placeholder="${placeholder}" min="0" ${splitType === 'percentage' ? 'max="100"' : ''}>
                                ${symbol && symbol !== '₹' ? `<span class="text-gray-500 ml-2">${symbol}</span>` : ''}
                            </div>
                        </div>
                    `;
                }));
                $("#split-details-container").html(detailsHtml.join(''));
            }
        });

        $("#person-form").submit(function (event) {
            event.preventDefault();
            const name = $("#person-name").val();
            if(name) {
                addPerson(name);
                $("#person-name").val('');
            }
        });

        $("#expense-form").submit(function (event) {
            event.preventDefault();
            const name = $("#expense-name").val();
            const amount = parseFloat($("#amount").val());
            const personId = $("#person-select").val();
            const splitWith = Array.from($("#split-with").val());
            const splitType = $("#split-type").val();

            if (!personId || !splitWith || splitWith.length === 0) {
                alert("Please select who paid and who to split with.");
                return;
            }

            let splitDetails = [];
            if (splitType !== 'equal') {
                splitDetails = Array.from($(".split-detail-input")).map(input => $(input).val());
                
                if (splitDetails.some(val => val === '' || isNaN(parseFloat(val)))) {
                    alert("Please fill in all split details with valid numbers.");
                    return;
                }

                if (splitType === 'exact') {
                    const totalSplit = splitDetails.reduce((sum, val) => sum + parseFloat(val), 0);
                    if (Math.abs(totalSplit - amount) > 0.01) {
                        alert("The sum of exact amounts must equal the total expense amount!");
                        return;
                    }
                }

                if (splitType === 'percentage') {
                    const totalPercentage = splitDetails.reduce((sum, val) => sum + parseFloat(val), 0);
                    if (Math.abs(totalPercentage - 100) > 0.01) {
                        alert("Percentages must sum to 100!");
                        return;
                    }
                }
            }

            addExpense(name, amount, personId, splitWith, splitType, splitDetails);

            $("#expense-form")[0].reset();
            $("#split-details-container").empty();
        });

        $("#simplify-debts").click(function () {
            simplifyDebtsHandler();
        });

        // Tab functionality
        $('.tab-btn').on('click', function() {
            const target = $(this).data('tab-target');
            
            // Update button styles
            $('.tab-btn').removeClass('text-blue-600 border-blue-600').addClass('text-gray-500 hover:text-gray-700 hover:border-gray-300 border-transparent');
            $(this).removeClass('text-gray-500 hover:text-gray-700 hover:border-gray-300 border-transparent').addClass('text-blue-600 border-blue-600');
            
            // Show/hide content
            $('.tab-content').addClass('hidden');
            $(target).removeClass('hidden');
        });
    });

    function deleteExpense(expenseId) {
        if (!confirm("Are you sure you want to delete this expense?")) return;
        const transaction = db.transaction(["expenses"], "readwrite");
        const expenseStore = transaction.objectStore("expenses");
        expenseStore.delete(expenseId);
        transaction.oncomplete = loadExpenses;
    }

    function clearDatabase() {
        if (!confirm("Are you sure you want to clear ALL data? This cannot be undone.")) return;

        const transaction = db.transaction(["expenses", "persons"], "readwrite");
        transaction.objectStore("expenses").clear();
        transaction.objectStore("persons").clear();

        transaction.oncomplete = () => {
            loadExpenses();
            loadPersons();
            $("#simplified-owes-list").empty();
            alert("All data has been cleared.");
        };
    }

    async function simplifyDebtsHandler() {
        const transaction = db.transaction(["expenses"], "readonly");
        const expenseStore = transaction.objectStore("expenses");
        const request = expenseStore.getAll();

        request.onsuccess = async (event) => {
            const expenses = event.target.result;
            let balances = {};

            for (const expense of expenses) {
                if (!balances[expense.personId]) balances[expense.personId] = 0;
                balances[expense.personId] += parseFloat(expense.amount);

                const splitAmounts = calculateSplitAmounts(
                    parseFloat(expense.amount), expense.splitType, expense.splitDetails, expense.splitWith, expense.personId
                );

                Object.entries(splitAmounts).forEach(([personId, amount]) => {
                    if (!balances[personId]) balances[personId] = 0;
                    balances[personId] -= amount;
                });
            }

            const simplifiedTransactions = simplifyDebts(balances);
            $("#simplified-owes-list").empty();
            if (simplifiedTransactions.length === 0) {
                 $("#simplified-owes-list").html(`<div class="text-center text-gray-500 py-10">
                    <h3 class="mt-2 text-sm font-medium text-gray-900">Nothing to simplify</h3>
                    <p class="mt-1 text-sm text-gray-500">Looks like everything is settled!</p>
                  </div>`);
            }

            for (const txn of simplifiedTransactions) {
                const fromName = await getPersonName(parseInt(txn.from));
                const toName = await getPersonName(parseInt(txn.to));
                $("#simplified-owes-list").append(`
                    <li class="balance-item owes border-green-500 bg-green-50">
                        <div><span class="font-semibold">${fromName}</span> should pay <span class="font-semibold">${toName}</span></div>
                        <div class="font-bold text-lg">₹${txn.amount.toFixed(2)}</div>
                    </li>
                `);
            }
        };
    }
    
    function simplifyDebts(balances) {
        let persons = [];
        for (const id in balances) {
            if (Math.abs(balances[id]) > 0.01) {
                persons.push({ id: id, balance: balances[id] });
            }
        }

        let creditors = persons.filter(p => p.balance > 0).sort((a, b) => b.balance - a.balance);
        let debtors = persons.filter(p => p.balance < 0).sort((a, b) => a.balance - b.balance);

        let transactions = [];
        while (creditors.length > 0 && debtors.length > 0) {
            let creditor = creditors[0];
            let debtor = debtors[0];
            let amount = Math.min(creditor.balance, -debtor.balance);
            transactions.push({ from: debtor.id, to: creditor.id, amount: amount });

            creditor.balance -= amount;
            debtor.balance += amount;

            if (Math.abs(creditor.balance) < 0.01) creditors.shift();
            if (Math.abs(debtor.balance) < 0.01) debtors.shift();
        }
        return transactions;
    }


    function updatePersonSharesList() {
        const transaction = db.transaction(["persons", "expenses"], "readonly");
        const personsReq = transaction.objectStore("persons").getAll();
        const expensesReq = transaction.objectStore("expenses").getAll();

        personsReq.onsuccess = function () {
            const persons = personsReq.result;
            expensesReq.onsuccess = function () {
                const expenses = expensesReq.result;
                const personTotals = {};
                persons.forEach(person => { personTotals[person.id] = 0; });
                
                expenses.forEach(expense => {
                    const splitAmounts = calculateSplitAmounts(
                        parseFloat(expense.amount), expense.splitType, expense.splitDetails, expense.splitWith, expense.personId
                    );
                    Object.entries(splitAmounts).forEach(([personId, amount]) => {
                        if (personTotals[personId] !== undefined) {
                            personTotals[personId] += amount;
                        }
                    });
                });
                
                $("#person-shares-list").empty();
                 if (persons.length === 0) {
                     $("#person-shares-list").html(`<div class="text-center text-gray-500 py-10">
                        <h3 class="mt-2 text-sm font-medium text-gray-900">No one here yet</h3>
                        <p class="mt-1 text-sm text-gray-500">Add people to see their expense summaries.</p>
                      </div>`);
                }
                persons.forEach(person => {
                    $("#person-shares-list").append(
                        `<div class="person-share-card">
                            <span>${person.name}</span>
                            <span>₹${personTotals[person.id].toFixed(2)}</span>
                        </div>`
                    );
                });

                // --- DETAILED SUMMARY LOGIC ---
                updateDetailedSummary(persons, expenses);
            };
        };
    }

    // Add this function for detailed summary
    function updateDetailedSummary(persons, expenses) {
        const container = $("#detailed-summary-list");
        container.empty();
        if (persons.length === 0) {
            container.html(`<div class="text-center text-gray-500 py-10">
                <h3 class="mt-2 text-sm font-medium text-gray-900">No one here yet</h3>
                <p class="mt-1 text-sm text-gray-500">Add people to see their detailed summary.</p>
            </div>`);
            return;
        }
        if (expenses.length === 0) {
            container.html(`<div class="text-center text-gray-500 py-10">
                <h3 class="mt-2 text-sm font-medium text-gray-900">No expenses yet</h3>
                <p class="mt-1 text-sm text-gray-500">Add expenses to see detailed summary.</p>
            </div>`);
            return;
        }
        persons.forEach(person => {
            let html = `<div class="mb-6 bg-gray-50 rounded-xl p-4 border border-gray-200">
                <div class="font-bold text-lg mb-2 text-blue-700">${person.name}</div>
                <table class="w-full text-sm mb-2">
                    <thead><tr>
                        <th class="text-left p-1">Expense</th>
                        <th class="text-left p-1">Paid By</th>
                        <th class="text-right p-1">Total</th>
                        <th class="text-right p-1">Their Share</th>
                        <th class="text-left p-1">Split Type</th>
                    </tr></thead>
                    <tbody>`;
            let hasShare = false;
            let totalShare = 0;
            expenses.forEach(expense => {
                const splitAmounts = calculateSplitAmounts(
                    parseFloat(expense.amount), expense.splitType, expense.splitDetails, expense.splitWith, expense.personId
                );
                if (splitAmounts[person.id] !== undefined) {
                    hasShare = true;
                    totalShare += splitAmounts[person.id];
                    html += `<tr>
                        <td class="p-1">${expense.name}</td>
                        <td class="p-1">${persons.find(p => p.id == expense.personId)?.name || 'Unknown'}</td>
                        <td class="p-1 text-right">₹${parseFloat(expense.amount).toFixed(2)}</td>
                        <td class="p-1 text-right">₹${splitAmounts[person.id].toFixed(2)}</td>
                        <td class="p-1">${capitalize(expense.splitType)}</td>
                    </tr>`;
                }
            });
            // Add total row if there was at least one share
            if (hasShare) {
                html += `<tr class="font-bold border-t border-gray-300">
                    <td class="p-1">Total</td>
                    <td class="p-1"></td>
                    <td class="p-1"></td>
                    <td class="p-1 text-right">₹${totalShare.toFixed(2)}</td>
                    <td class="p-1"></td>
                </tr>`;
            }
            html += `</tbody></table>`;
            if (!hasShare) {
                html += `<div class="text-gray-400 text-sm">No share in any expense.</div>`;
            }
            html += `</div>`;
            container.append(html);
        });
    }

    // Helper to capitalize split type
    function capitalize(str) {
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    $('#share-db').click(async () => {
        try {
            const allData = await readAllIndexedDB();
            const json = JSON.stringify(allData);
            const compressed = LZString.compressToEncodedURIComponent(json);
            const url = `${location.origin + location.pathname}?data=${compressed}`;
            if (url.length > MAX_URL_LENGTH) {
                $('#share-error').text('Data is too large to share via URL.');
                $('#share-link').val('');
            } else {
                $('#share-error').text('');
                $('#share-link').val(url);
            }
            $('#share-modal').removeClass('hidden');
        } catch (e) {
            $('#share-error').text('Error preparing data for sharing.');
        }
    });

    $('#share-close').click(() => {
        $('#share-modal').addClass('hidden');
    });

    async function readAllIndexedDB() {
        return new Promise((resolve, reject) => {
            const result = {};
            const txn = db.transaction(db.objectStoreNames, 'readonly');
            txn.onerror = () => reject(txn.error);
            let count = 0;
            for (const name of db.objectStoreNames) {
                const storeReq = txn.objectStore(name).getAll();
                storeReq.onsuccess = () => {
                    result[name] = storeReq.result;
                    count++;
                    if (count === db.objectStoreNames.length) {
                        resolve(result);
                    }
                };
            }
        });
    }

    function loadIntoIndexedDB(data) {
        const txn = db.transaction(db.objectStoreNames, 'readwrite');
        for (const name of db.objectStoreNames) {
            const store = txn.objectStore(name);
            store.clear();
            const items = data[name] || [];
            items.forEach(item => store.add(item));
        }
        txn.oncomplete = () => {
            loadPersons();
            loadExpenses();
            updatePersonSharesList();
            alert('Shared data loaded successfully!');
        };
    }