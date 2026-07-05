
require('dotenv').config();



const mongoose = require('mongoose');

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error("CRITICAL ERROR: process.env.MONGO_URI is undefined! Checking .env layout...");
}

mongoose.connect(uri)
  .then(() => console.log('Live Production Database Connected'))
  .catch(err => console.error('Database connection failed:', err));

// Wallet schema tracking real locked fiat balances mapped to user hardware profiles
const ActiveWalletSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  role: { type: String, enum: ['payer', 'merchant'], required: true },
  liveFrozenBalance: { type: Number, default: 0 },
  clientPublicKey: { type: String, default: "mock_device_public_key_rsa_0567" },
  
  // Dynamic Merchant Banking Routing Metadata
  bankDetails: {
    accountHolderName: { type: String, default: "" },
    accountNumber: { type: String, default: "" },
    ifscCode: { type: String, default: "" }
  },
  createdAt: { type: Date, default: Date.now }
});

const SettlementRecordSchema = new mongoose.Schema({
  transactionId: { type: String, required: true, unique: true },
  invoiceNonce: { type: String, required: true, unique: true },
  payerId: { type: String, required: true },
  merchantId: { type: String, required: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['SUCCESS', 'FRAUD_REJECTED'], required: true },
  settledAt: { type: Date, default: Date.now }
});

const ActiveWallet = mongoose.model('ActiveWallet', ActiveWalletSchema);
const SettlementRecord = mongoose.model('SettlementRecord', SettlementRecordSchema);

module.exports = { ActiveWallet, SettlementRecord };