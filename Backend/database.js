
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
  liveFrozenBalance: { type: Number, required: true, min: 0 }, 
  clientPublicKey: { type: String, required: true } 
});

// Settlement schema ensuring single-execution processing (Strict Idempotency)
const SettlementRecordSchema = new mongoose.Schema({
  transactionId: { type: String, required: true, unique: true }, 
  payerId: { type: String, required: true },
  merchantId: { type: String, required: true },
  amount: { type: Number, required: true },
  settledAt: { type: Date, default: Date.now },
  status: { type: String, enum: ['SUCCESS', 'FRAUD_REJECTED'], required: true }
});

const ActiveWallet = mongoose.model('ActiveWallet', ActiveWalletSchema);
const SettlementRecord = mongoose.model('SettlementRecord', SettlementRecordSchema);

module.exports = { ActiveWallet, SettlementRecord };