Component review report
=======================

This folder is the interactive review of the KiCad footprints and symbols changed in a pull
request (unzipped from the CI artifact). Two ways to open it:

1. Double-click index.html (Chrome, Edge or Firefox).
   Overview, item list, all 2D view modes, details, text diffs and the checks work straight
   from disk. The 3D view also works in Chromium-based browsers; it needs internet access
   (three.js and the STEP kernel come from cdn.jsdelivr.net). If the 3D tab shows an error, use
   option 2.

2. Run a tiny local web server (Python 3, no packages needed):

       python3 serve.py

   It listens on 127.0.0.1 only, picks a free port, prints the address and opens your browser.
   Everything works this way, including the 3D view. Stop it with Ctrl-C.

The report content comes from the pull request. The viewer shows it as plain text and never
runs anything from it.
