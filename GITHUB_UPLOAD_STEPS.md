# GitHub Upload Steps

This project is ready to upload after the generated files are excluded by `.gitignore`.

## Option 1: Upload With GitHub Desktop

1. Open GitHub Desktop.
2. Choose `File > Add local repository`.
3. Select this folder:

   ```text
   C:\Users\aiden\OneDrive\Documents\QC
   ```

4. If GitHub Desktop says the repository is invalid, the existing `.git` folder is broken. Rename `.git` to `.git_old`, then add the folder again.
5. Review the changed files. Generated folders like `data/sga_qc/runs`, `data/sga_qc/cache`, `uploads`, `tmp`, logs, and `.venv` should not appear.
6. Commit with a message like:

   ```text
   Initial SGA QC checker app
   ```

7. Click `Publish repository`.

## Option 2: Upload With PowerShell

Run these from this folder:

```powershell
cd "C:\Users\aiden\OneDrive\Documents\QC"
```

If `git status` says this is not a valid repository, rename the broken `.git` folder first:

```powershell
Rename-Item -Path ".git" -NewName ".git_old"
git init
```

Then commit and push:

```powershell
git add .
git status
git commit -m "Initial SGA QC checker app"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO-NAME.git
git push -u origin main
```

Replace `YOUR-USERNAME` and `YOUR-REPO-NAME` with your GitHub account and repository name.

## Do Not Upload

These are intentionally ignored:

- `.venv/`
- `data/sga_qc/runs/`
- `data/sga_qc/cache/`
- `data/uploads/`
- `uploads/`
- `reports/`
- `output/`
- `tmp/`
- log files
- local databases
- uploaded PDFs and generated reports

