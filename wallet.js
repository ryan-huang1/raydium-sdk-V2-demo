const {
  Keypair,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  clusterApiUrl,
} = require("@solana/web3.js");
const fs = require("fs");
const crypto = require("crypto");

class SolanaWallet {
  constructor() {
    // Initialize connection to Solana devnet
    this.connection = new Connection(clusterApiUrl("devnet"), "confirmed");
    this.keypair = null;
    this.algorithm = "aes-256-gcm";
    this.keyLength = 32;
    this.ivLength = 16;
    this.saltLength = 64;
  }

  // Derive encryption key from password
  #deriveKey(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 100000, this.keyLength, "sha256");
  }

  // Encrypt data
  #encrypt(text, password) {
    const salt = crypto.randomBytes(this.saltLength);
    const key = this.#deriveKey(password, salt);
    const iv = crypto.randomBytes(this.ivLength);
    const cipher = crypto.createCipheriv(this.algorithm, key, iv);

    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");
    const authTag = cipher.getAuthTag();

    return {
      encrypted,
      iv: iv.toString("hex"),
      authTag: authTag.toString("hex"),
      salt: salt.toString("hex"),
    };
  }

  // Decrypt data
  #decrypt(encrypted, password, iv, authTag, salt) {
    const key = this.#deriveKey(password, Buffer.from(salt, "hex"));
    const decipher = crypto.createDecipheriv(
      this.algorithm,
      key,
      Buffer.from(iv, "hex")
    );
    decipher.setAuthTag(Buffer.from(authTag, "hex"));

    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  }

  // Create a new wallet
  createWallet(password) {
    if (!password) {
      throw new Error("Password is required to create a wallet");
    }

    this.keypair = Keypair.generate();
    return {
      publicKey: this.keypair.publicKey.toString(),
      secretKey: Buffer.from(this.keypair.secretKey).toString("hex"),
    };
  }

  // Load wallet from secret key
  loadWalletFromPrivateKey(secretKeyHex) {
    const secretKey = Buffer.from(secretKeyHex, "hex");
    this.keypair = Keypair.fromSecretKey(secretKey);
    return this.keypair.publicKey.toString();
  }

  // Save wallet to file
  saveWalletToFile(filename, password) {
    if (!this.keypair) {
      throw new Error("No wallet loaded");
    }
    if (!password) {
      throw new Error("Password is required to save the wallet");
    }

    const walletData = {
      publicKey: this.keypair.publicKey.toString(),
      secretKey: Buffer.from(this.keypair.secretKey).toString("hex"),
    };

    // Encrypt the wallet data
    const encryptedData = this.#encrypt(JSON.stringify(walletData), password);

    // Save encrypted data
    const fileData = {
      version: "1.0",
      encrypted: encryptedData.encrypted,
      iv: encryptedData.iv,
      authTag: encryptedData.authTag,
      salt: encryptedData.salt,
      publicKey: walletData.publicKey, // Keep public key unencrypted for reference
    };

    fs.writeFileSync(filename, JSON.stringify(fileData, null, 2));
  }

  // Load wallet from file
  loadWalletFromFile(filename, password) {
    if (!password) {
      throw new Error("Password is required to load the wallet");
    }

    const fileData = JSON.parse(fs.readFileSync(filename, "utf8"));

    try {
      // Decrypt the wallet data
      const decrypted = this.#decrypt(
        fileData.encrypted,
        password,
        fileData.iv,
        fileData.authTag,
        fileData.salt
      );

      const walletData = JSON.parse(decrypted);
      return this.loadWalletFromPrivateKey(walletData.secretKey);
    } catch (error) {
      throw new Error(
        "Failed to decrypt wallet. Invalid password or corrupted file."
      );
    }
  }

  // Get wallet balance
  async getBalance() {
    if (!this.keypair) {
      throw new Error("No wallet loaded");
    }

    const balance = await this.connection.getBalance(this.keypair.publicKey);
    return balance / LAMPORTS_PER_SOL; // Convert lamports to SOL
  }

  // Request airdrop (only works on devnet)
  async requestAirdrop(amount = 1) {
    if (!this.keypair) {
      throw new Error("No wallet loaded");
    }

    try {
      const signature = await this.connection.requestAirdrop(
        this.keypair.publicKey,
        amount * LAMPORTS_PER_SOL
      );
      await this.connection.confirmTransaction(signature);
      return signature;
    } catch (error) {
      throw new Error(`Airdrop failed: ${error.message}`);
    }
  }

  // Get public key
  getPublicKey() {
    if (!this.keypair) {
      throw new Error("No wallet loaded");
    }
    return this.keypair.publicKey.toString();
  }
}

module.exports = SolanaWallet;
