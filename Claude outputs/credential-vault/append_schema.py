"""Append the Credential Vault models to prisma/schema.prisma, matching its line endings."""
import sys, pathlib
root = pathlib.Path(sys.argv[1])
block = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8")
path = root / "prisma" / "schema.prisma"
with open(path, encoding="utf-8", newline="") as fh:
    text = fh.read()
if "model credentialVaults {" in text:
    print("skip: already present"); sys.exit(0)
eol = "\r\n" if "\r\n" in text else "\n"
if not text.endswith(eol):
    text += eol
text += eol + block.replace("\r\n", "\n").replace("\n", eol)
with open(path, "w", encoding="utf-8", newline="") as fh:
    fh.write(text)
print("ok: schema.prisma")
