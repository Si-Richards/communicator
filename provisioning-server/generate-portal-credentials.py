"""Generate the two administrator portal .env values without echoing the password."""
import getpass
import hashlib
import secrets

password = getpass.getpass("New portal password: ")
confirmation = getpass.getpass("Confirm portal password: ")
if password != confirmation:
    raise SystemExit("Passwords did not match.")
if len(password) < 14:
    raise SystemExit("Use a password of at least 14 characters.")
salt = secrets.token_bytes(16)
iterations = 600000
digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
print("Add these to provisioning-server/.env (keep them private):")
print("PROVISIONING_PORTAL_SECRET=" + secrets.token_urlsafe(48))
print("PROVISIONING_PORTAL_PASSWORD_HASH=pbkdf2_sha256$" + str(iterations) + "$" +
      salt.hex() + "$" + digest.hex())
