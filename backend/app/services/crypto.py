import base64
import binascii
import os
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from app.config import settings


def _get_key() -> bytes:
    """Decodifica a ENCRYPTION_KEY de forma robusta.

    Aceita base64 padrao ou url-safe, com ou sem padding. A chave deve
    resultar em 16, 24 ou 32 bytes (AES-128/192/256). Padroniza o
    comprimento adicionando o padding '=' que faltar.
    """
    raw = settings.encryption_key.strip()
    padded = raw + "=" * (-len(raw) % 4)
    for decoder in (base64.urlsafe_b64decode, base64.b64decode):
        try:
            key = decoder(padded)
            if len(key) in (16, 24, 32):
                return key
        except (binascii.Error, ValueError):
            continue
    raise ValueError(
        "ENCRYPTION_KEY invalida: precisa ser base64 (padrao ou url-safe) "
        "de uma chave de 16, 24 ou 32 bytes."
    )


def encrypt(plaintext: str) -> str:
    key = _get_key()
    aesgcm = AESGCM(key)
    nonce = os.urandom(12)
    ciphertext = aesgcm.encrypt(nonce, plaintext.encode(), None)
    combined = nonce + ciphertext
    return base64.b64encode(combined).decode()


def decrypt(encrypted: str) -> str:
    key = _get_key()
    aesgcm = AESGCM(key)
    combined = base64.b64decode(encrypted)
    nonce = combined[:12]
    ciphertext = combined[12:]
    plaintext = aesgcm.decrypt(nonce, ciphertext, None)
    return plaintext.decode()
