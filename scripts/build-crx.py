#!/usr/bin/env python3
"""
UI Checker v3 — CRX3 Package Builder

Builds both a ZIP (Chrome Web Store format) and a CRX3 (direct install format)
from the extension source directory.

CRX3 Format Reference (Chrome Extensions Official Docs):
  https://developer.chrome.com/docs/extensions/how-to/distribute

  The CRX3 binary format is:
    [4 bytes] Magic number: "Cr24" (0x43 0x72 0x32 0x34)
    [4 bytes] Format version: 3 (0x03 0x00 0x00 0x00, little-endian)
    [4 bytes] Header length (little-endian uint32)
    [N bytes] CRX3 header (protobuf-encoded CrxFileHeader)
    [rest]    ZIP archive of the extension

  The CRX3 header protobuf schema:
    message AsymmetricKeyProof {
      optional bytes public_key = 1;
      optional bytes signature = 2;
    }
    message SignedData {
      optional bytes crx_id = 1;  // first 16 bytes of SHA-256 of public key
    }
    message CrxFileHeader {
      repeated AsymmetricKeyProof sha256_with_rsa = 2;
      optional SignedData signed_header_data = 3;
    }

  Signature is computed over: b"CRX3 Signed Data" + serialized SignedData + ZIP bytes
  Using SHA-256 with RSA (RSASSA-PKCS1-v1_5 with SHA-256)

Requirements:
  - Python 3.8+
  - cryptography package (pip install cryptography)

Usage:
  python3 scripts/build-crx.py [--source DIR] [--output DIR] [--key PATH]

  If no key is provided, a new RSA-2048 key is generated and saved as
  uichecker-key.pem next to the output CRX file.
"""

import argparse
import io
import json
import os
import struct
import sys
import zipfile
from pathlib import Path

# ── Minimal protobuf encoder (no external protobuf dependency) ──
# We only need field types: bytes (wire type 2), uint32 (wire type 0),
# and repeated embedded messages.

def encode_varint(value):
    """Encode an integer as a protobuf varint."""
    parts = []
    while value > 0x7F:
        parts.append((value & 0x7F) | 0x80)
        value >>= 7
    parts.append(value & 0x7F)
    return bytes(parts)


def encode_field_tag(field_number, wire_type):
    """Encode a protobuf field tag."""
    return encode_varint((field_number << 3) | wire_type)


def encode_bytes_field(field_number, value):
    """Encode a bytes field (wire type 2: length-delimited)."""
    return (encode_field_tag(field_number, 2)
            + encode_varint(len(value))
            + value)


def encode_message_field(field_number, message_bytes):
    """Encode an embedded message field (wire type 2: length-delimited)."""
    return (encode_field_tag(field_number, 2)
            + encode_varint(len(message_bytes))
            + message_bytes)


def encode_crx3_header(public_key_der, signature, crx_id):
    """
    Build the CRX3 CrxFileHeader protobuf:
      message CrxFileHeader {
        repeated AsymmetricKeyProof sha256_with_rsa = 2;
        optional SignedData signed_header_data = 3;
      }
      message AsymmetricKeyProof {
        optional bytes public_key = 1;
        optional bytes signature = 2;
      }
      message SignedData {
        optional bytes crx_id = 1;
      }
    """
    # AsymmetricKeyProof
    proof = encode_bytes_field(1, public_key_der) + encode_bytes_field(2, signature)

    # SignedData
    signed_data = encode_bytes_field(1, crx_id)

    # CrxFileHeader
    header = encode_message_field(2, proof) + encode_message_field(3, signed_data)
    return header


def create_zip_from_directory(source_dir):
    """
    Create a ZIP archive of the extension directory.
    Excludes .git, node_modules, scripts, and dev files.
    Returns bytes of the ZIP archive.
    """
    buf = io.BytesIO()
    exclude_dirs = {'.git', 'node_modules', 'scripts', '__pycache__', '.DS_Store'}
    exclude_exts = {'.pyc', '.pem', '.crx', '.zip'}

    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        source_path = Path(source_dir).resolve()
        for root, dirs, files in os.walk(source_path):
            # Skip excluded directories (in-place filter)
            dirs[:] = [d for d in dirs if d not in exclude_dirs]

            for filename in sorted(files):
                if any(filename.endswith(ext) for ext in exclude_exts):
                    continue
                if filename.startswith('.') and filename != '.htaccess':
                    continue

                filepath = Path(root) / filename
                arcname = str(filepath.relative_to(source_path))
                # Use forward slashes for ZIP (required by Chrome)
                arcname = arcname.replace(os.sep, '/')

                with open(filepath, 'rb') as f:
                    data = f.read()

                zf.writestr(arcname, data)

    return buf.getvalue()


def sign_crx3(zip_bytes, private_key):
    """
    Sign the ZIP content for CRX3 format.
    Returns (public_key_der, signature, crx_id).

    The signature is over: b"CRX3 Signed Data" + serialized SignedData + zip_bytes
    Algorithm: RSASSA-PKCS1-v1_5 with SHA-256
    """
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding

    # Get public key in DER format
    public_key_der = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )

    # CRX ID = first 16 bytes of SHA-256 of the DER public key
    digest = hashes.Hash(hashes.SHA256())
    digest.update(public_key_der)
    crx_id = digest.finalize()[:16]

    # Build the SignedData protobuf for signing
    signed_data_proto = encode_bytes_field(1, crx_id)

    # Compute signature over: "CRX3 Signed Data" + signed_data + zip
    message = b"CRX3 Signed Data" + signed_data_proto + zip_bytes

    signature = private_key.sign(
        message,
        padding.PKCS1v15(),
        hashes.SHA256(),
    )

    return public_key_der, signature, crx_id


def build_crx3(zip_bytes, private_key):
    """
    Build a CRX3 binary from ZIP bytes and an RSA private key.
    Returns the complete CRX3 file as bytes.
    """
    public_key_der, signature, crx_id = sign_crx3(zip_bytes, private_key)
    header = encode_crx3_header(public_key_der, signature, crx_id)

    # CRX3 binary layout:
    #   "Cr24" (4 bytes)
    #   version 3 (4 bytes LE)
    #   header length (4 bytes LE)
    #   header (header_length bytes)
    #   ZIP archive
    crx = (
        b"Cr24"
        + struct.pack('<I', 3)               # version = 3
        + struct.pack('<I', len(header))      # header length
        + header
        + zip_bytes
    )
    return crx


def generate_rsa_key():
    """Generate a new RSA-2048 key pair."""
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives import serialization

    private_key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048,
    )
    return private_key


def load_rsa_key(key_path):
    """Load an RSA private key from a PEM file."""
    from cryptography.hazmat.primitives import serialization

    with open(key_path, 'rb') as f:
        private_key = serialization.load_pem_private_key(f.read(), password=None)
    return private_key


def save_rsa_key(private_key, key_path):
    """Save an RSA private key to a PEM file."""
    from cryptography.hazmat.primitives import serialization

    pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    )
    with open(key_path, 'wb') as f:
        f.write(pem)
    return key_path


def get_extension_version(source_dir):
    """Read version from manifest.json."""
    manifest_path = Path(source_dir) / 'manifest.json'
    with open(manifest_path) as f:
        manifest = json.load(f)
    return manifest.get('version', '0.0.0')


def main():
    parser = argparse.ArgumentParser(
        description='Build UI Checker v3 extension packages (ZIP + CRX3)')
    parser.add_argument('--source', default='.',
                        help='Extension source directory (default: current)')
    parser.add_argument('--output', default=None,
                        help='Output directory (default: ./dist)')
    parser.add_argument('--key', default=None,
                        help='Path to RSA private key PEM (generates new key if not provided)')
    args = parser.parse_args()

    source_dir = Path(args.source).resolve()
    output_dir = Path(args.output) if args.output else source_dir / 'dist'
    output_dir.mkdir(parents=True, exist_ok=True)

    # Validate source directory
    manifest_path = source_dir / 'manifest.json'
    if not manifest_path.exists():
        print(f"Error: manifest.json not found in {source_dir}", file=sys.stderr)
        sys.exit(1)

    version = get_extension_version(source_dir)
    base_name = f"uichecker-v{version}"

    print(f"Building UI Checker v{version} packages...")
    print(f"  Source: {source_dir}")
    print(f"  Output: {output_dir}")

    # 1. Create ZIP archive
    print("\n[1/3] Creating ZIP archive...")
    zip_bytes = create_zip_from_directory(source_dir)
    zip_path = output_dir / f"{base_name}.zip"
    with open(zip_path, 'wb') as f:
        f.write(zip_bytes)
    print(f"  Written: {zip_path} ({len(zip_bytes):,} bytes)")

    # 2. Load or generate RSA key
    print("\n[2/3] Preparing signing key...")
    if args.key:
        private_key = load_rsa_key(args.key)
        print(f"  Loaded existing key: {args.key}")
    else:
        key_path = output_dir / "uichecker-key.pem"
        if key_path.exists():
            private_key = load_rsa_key(key_path)
            print(f"  Loaded existing key: {key_path}")
        else:
            private_key = generate_rsa_key()
            save_rsa_key(private_key, key_path)
            print(f"  Generated new key: {key_path}")
            print(f"  WARNING: Keep this key safe! It identifies your extension.")
            print(f"  Chrome uses the public key to derive the extension ID.")
            print(f"  Losing this key means you cannot publish updates to the same extension ID.")

    # 3. Build CRX3 package
    print("\n[3/3] Building CRX3 package...")
    crx_bytes = build_crx3(zip_bytes, private_key)
    crx_path = output_dir / f"{base_name}.crx"
    with open(crx_path, 'wb') as f:
        f.write(crx_bytes)
    print(f"  Written: {crx_path} ({len(crx_bytes):,} bytes)")

    # Compute and display the extension ID (Chrome's algorithm)
    from cryptography.hazmat.primitives import hashes, serialization
    public_key_der = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    digest = hashes.Hash(hashes.SHA256())
    digest.update(public_key_der)
    key_hash = digest.finalize()
    # Chrome extension ID = first 16 bytes of SHA-256, encoded as lowercase hex
    # with characters a-p (modular hex, not standard hex)
    # Actually, Chrome uses a specific base16 encoding: 0-9 → a-j, a-f → k-p
    extension_id_bytes = key_hash[:16]
    # Chrome's "modular hex" encoding: each nibble maps to a-p
    chrome_chars = 'abcdefghijklmnop'
    extension_id = ''
    for byte in extension_id_bytes:
        extension_id += chrome_chars[(byte >> 4) & 0xF]
        extension_id += chrome_chars[byte & 0xF]

    print(f"\n{'='*60}")
    print(f"  UI Checker v{version} — Build Complete")
    print(f"{'='*60}")
    print(f"  ZIP:  {zip_path.name} ({len(zip_bytes):,} bytes)")
    print(f"        ↑ Upload to Chrome Web Store or load as unpacked")
    print(f"  CRX3: {crx_path.name} ({len(crx_bytes):,} bytes)")
    print(f"        ↑ Direct install (drag into chrome://extensions)")
    print(f"  Key:  uichecker-key.pem")
    print(f"        ↑ KEEP SAFE — needed for extension ID + updates")
    print(f"  Extension ID: {extension_id}")
    print(f"{'='*60}")

    # Installation instructions
    print(f"""
  Installation Methods:
  ─────────────────────
  1. Developer (unpacked):
     chrome://extensions → Enable "Developer mode" → "Load unpacked"
     → Select the source directory: {source_dir}

  2. CRX3 (direct install):
     chrome://extensions → Enable "Developer mode"
     → Drag {crx_path.name} into the browser window

  3. Chrome Web Store (public):
     → Upload {zip_path.name} to https://chrome.google.com/webstore/devconsole

  4. Enterprise policy:
     → Use the CRX3 path + extension ID {extension_id}
     → Configure ExtensionInstallForcelist policy
""")


if __name__ == '__main__':
    main()
