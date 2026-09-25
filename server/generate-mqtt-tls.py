#!/usr/bin/env python3
"""Generate a private CA and an IP-bound MQTT server certificate.

The CA key remains local. Only ca.pem is provisioned to the modem. Existing
files are never overwritten so certificate rotation is always deliberate.
"""

from __future__ import annotations

import argparse
import datetime as dt
import ipaddress
import os
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


def write_new(path: Path, data: bytes, private: bool = False) -> None:
    if path.exists():
        raise FileExistsError(f"refusing to overwrite {path}")
    path.write_bytes(data)
    if private:
        os.chmod(path, 0o600)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--reuse-ca", type=Path,
                        help="Existing local CA directory; issue a new server leaf without rotating device trust")
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    try:
        host_identity: x509.GeneralName = x509.IPAddress(ipaddress.ip_address(args.host))
    except ValueError:
        host_identity = x509.DNSName(args.host)
    now = dt.datetime.now(dt.timezone.utc)

    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "ESP32 Device Bridge MQTT CA")])
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                key_encipherment=False,
                key_cert_sign=True,
                key_agreement=False,
                content_commitment=False,
                data_encipherment=False,
                encipher_only=False,
                decipher_only=False,
                crl_sign=True,
            ),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )

    if args.reuse_ca:
        ca_cert = x509.load_pem_x509_certificate((args.reuse_ca / "ca.pem").read_bytes())
        ca_key = serialization.load_pem_private_key(
            (args.reuse_ca / "ca-key.pem").read_bytes(), password=None)
        if not ca_cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
            raise ValueError("reuse certificate is not a CA")
        if ca_key.public_key().public_numbers() != ca_cert.public_key().public_numbers():
            raise ValueError("CA certificate/key mismatch")
        if not ca_cert.not_valid_before_utc <= now < ca_cert.not_valid_after_utc:
            raise ValueError("CA certificate is outside its validity period")
        ca_name = ca_cert.subject

    server_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    server_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, args.host)])
    server_cert = (
        x509.CertificateBuilder()
        .subject_name(server_name)
        .issuer_name(ca_name)
        .public_key(server_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=825))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.SubjectAlternativeName([host_identity]), critical=False)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                key_encipherment=True,
                key_cert_sign=False,
                key_agreement=False,
                content_commitment=False,
                data_encipherment=False,
                encipher_only=False,
                decipher_only=False,
                crl_sign=False,
            ),
            critical=True,
        )
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(ca_key, hashes.SHA256())
    )

    write_new(
        args.output / "ca-key.pem",
        ca_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        ),
        private=True,
    )
    write_new(args.output / "ca.pem", ca_cert.public_bytes(serialization.Encoding.PEM))
    write_new(
        args.output / "server-key.pem",
        server_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        ),
        private=True,
    )
    write_new(args.output / "server.pem", server_cert.public_bytes(serialization.Encoding.PEM))

    fingerprint = server_cert.fingerprint(hashes.SHA256()).hex()
    print(f"server_host={args.host}")
    print(f"server_certificate_sha256={fingerprint}")
    print(f"ca_certificate_bytes={(args.output / 'ca.pem').stat().st_size}")


if __name__ == "__main__":
    main()
