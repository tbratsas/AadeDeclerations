# Μαζική αποδοχή εξουσιοδοτήσεων myAADE

Αυτοματοποιεί την αποδοχή εξουσιοδοτήσεων **Παρόχου Ηλεκτρονικής Τιμολόγησης**
στο myAADE, για λίστα ΑΦΜ πελατών.

```powershell
cd C:\Data\develop\declaretions
node src/aade-accept.js          # dry run — δεν στέλνει τίποτα
node src/aade-accept.js --go     # κανονικά
```

## Τεκμηρίωση

| Αρχείο | Περιεχόμενο |
|---|---|
| **[ΟΔΗΓΙΕΣ.md](ΟΔΗΓΙΕΣ.md)** | Πλήρεις οδηγίες χρήσης, flags, επίλυση προβλημάτων |
| **[CLAUDE.md](CLAUDE.md)** | Τεχνικό υπόβαθρο: endpoints, σχεδιαστικές αποφάσεις, κανόνες |

## Εγκατάσταση

```powershell
npm install
npx playwright install chromium
```

## Ασφάλεια

Τα TAXISnet credentials **δεν αποθηκεύονται πουθενά** — το login το κάνει ο
χρήστης χειροκίνητα στο παράθυρο που ανοίγει. Το `.profile/`, το `afm.txt` και
τα `logs/` είναι στο `.gitignore` (session cookies και προσωπικά δεδομένα).
