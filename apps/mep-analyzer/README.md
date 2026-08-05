# SGA MEP Analyzer

A local architectural pre-design tool for finding SGA precedents, developing preliminary MEP planning ranges, and reviewing recorded consultant experience. The application uses Express, vanilla HTML/CSS/JavaScript, SheetJS, Chart.js, and local JSON storage. It does not use external AI services, cloud storage, accounts, or a database.

## Run the application

1. Open PowerShell in this folder.
2. Install packages once:

   ```powershell
   npm.cmd install
   ```

3. Start the site:

   ```powershell
   npm.cmd start
   ```

4. Open [http://localhost:3000](http://localhost:3000) in a browser.

If PowerShell permits npm scripts on your computer, `npm install` and `npm start` work as well. Keep the PowerShell window open while using the site. Press `Ctrl+C` to stop it.

## Data workflow

- The included records are fictional and labeled **Demonstration Data — Replace With Firm Spreadsheet**.
- Use **Data Import** to preview, map, clean, and save Mechanical or Electrical `.xlsx`, `.xls`, and `.csv` files.
- Existing `ERRORS` sheets are imported into the structured **Data Quality** log without discarding the original note text.
- Use **Updates** for quick individual project additions and revisions. Recorded values remain separate from historical estimates.
- Blocking records can be retained as excluded; warnings can be saved after confirmation.
- The first real import removes the demonstration records.
- The primary data store is `data/data.json` on this computer. Automatic JSON snapshots are kept in `data/backups/` (latest 20).
- **Download Latest Excel** creates a combined workbook with Projects, Mechanical Equipment, Electrical, ERRORS, Consultants Summary, and Notes sheets.
- **Maintain Local Master Excel File** is optional. When enabled, it writes `SGA_MEP_Master.xlsx` to the explicitly configured folder using a temporary file, validates it, backs up the previous workbook, and then replaces it.
- Original imported spreadsheets are never overwritten by default.
- Data is stored on this installation unless the application is deployed to a shared firm server.

## Tests

Run:

```powershell
npm.cmd test
```

The automated tests cover precedent ranking, consultant-name normalization, CSV export, numeric cleanup, project-level forward filling, TOTAL-row validation, equipment grouping, electrical column aliases, panel aggregation, duplicate and conflict handling, replace/add modes, project updates, warning/blocking saves, analysis exclusion, issue import and resolution history, workbook generation, JSON/workbook backups, discipline merging, and persistence across a server restart.
