const mongoose = require('mongoose');

const AssetVoucherSchema = new mongoose.Schema({
  voucherId: { type: String, required: true, unique: true }, // Unique string for the crypto asset block
  ownerId: { type: String, required: true },
  fiatValueINR: { type: Number, required: true },
  cryptoTokenAmount: { type: Number, required: true }, // Equivalent crypto value
  serverSignature: { type: String, required: true },  // Proves our server minted this crypto asset
  isRedeemed: { type: Boolean, default: false },
  redeemedBy: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('AssetVoucher', AssetVoucherSchema);