#!/bin/sh
# Rebuild Boord_Notes_Training_Guide.pdf from training-guide.html.
# Needs WeasyPrint (pip install weasyprint). Screenshots live in img/.
set -e
cd "$(dirname "$0")"
python3 -c "import weasyprint; weasyprint.HTML('training-guide.html').write_pdf('../../Boord_Notes_Training_Guide.pdf')"
echo "Wrote Boord_Notes_Training_Guide.pdf"
