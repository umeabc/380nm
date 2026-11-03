"""Build the installable plugin ZIP, excluding tests, caches and local config."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


root = Path(__file__).resolve().parent.parent
name = "astrbot_plugin_380nm"
source = root / "plugins" / name
files = ["__init__.py", "main.py", "bridge.py", "commands.py", "views.py", "metadata.yaml",
         "_conf_schema.json", "requirements.txt", "README.md"]
for filename in files:
    if not (source / filename).is_file():
        raise SystemExit(f"Missing plugin file: {filename}")
output = root / "dist" / f"{name}.zip"
output.parent.mkdir(exist_ok=True)
with ZipFile(output, "w", ZIP_DEFLATED) as archive:
    for filename in files:
        archive.write(source / filename, f"{name}/{filename}")
    archive.write(root / "LICENSE", f"{name}/LICENSE")
with ZipFile(output) as archive:
    if archive.testzip() is not None:
        raise SystemExit("ZIP verification failed")
print(output)
