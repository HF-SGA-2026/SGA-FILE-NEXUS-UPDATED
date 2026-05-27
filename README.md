# SGA-FILE-RENAME
SGA FILE NEXUS is a browser-based tool that helps you quickly organize and rename large batches of files inside nested folders. It runs entirely on your device, provides a live preview before changes are made, and exports a clean, structured ZIP file. This makes it ideal for managing photos, documents, and bulk project assets efficiently.

## Run as a Local Server

```bash
npm start
```

Open:

```text
http://localhost:8080
```

When run this way, SGA FILE NEXUS can send the selected files to the local server so the server creates the ZIP for large exports. HEIC/HEIF conversion still uses the browser path because the local server does not include an image converter.

## Large Folder Server Mode

1. Start the app with `npm start`.
2. Open `http://localhost:8080`.
3. Copy the full path to the main folder you want to process.
4. Paste that path into the server folder path box.
5. Click **Scan Server Folder**.
6. Review the summary, settings, duplicate sections, and planned renames.
7. Click **Export ZIP**.
8. Click **Download ZIP**.

In server folder mode, the server scans the folder from disk, hashes duplicate files on the server, and streams the final ZIP from disk. The original folder is not changed.
