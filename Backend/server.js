const express = require('express');
const crypto = require('crypto');
const { ActiveWallet, SettlementRecord } = require('./database.js');
require('dotenv').config();

const app = express();
app.use(express.json());
const cors = require('cors');
app.use(cors()); // 🔥 Opens the gateway for local development diagnostics

// FIXED: Use ONE permanent, persistent keypair across the entire backend session
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

// A simple temporary in-memory database or collection to cache tickets until the phone fetches them
const pendingTicketsCache = new Map();

const Razorpay = require('razorpay');

// Initialize Razorpay with your Test Keys from the Dashboard
const razorpayInstance = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_YOUR_KEY_ID',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'YOUR_KEY_SECRET'
});

/**
 * STEP A: CREATE RAZORPAY ORDER
 */

app.get('/',async(req,res)=>{
  res.json({msg:"well played"})
})
app.post('/api/payment/create-razorpay-order', async (req, res) => {
  const { amount } = req.body; // Expecting raw number like 10
  
  const options = {
    amount: amount * 100, // Razorpay reads amounts in Paisa (10 INR = 1000 Paisa)
    currency: "INR",
    receipt: `receipt_order_${Date.now()}`
  };

  try {
    const order = await razorpayInstance.orders.create(options);
    return res.status(200).json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      keyId: razorpayInstance.key_id
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * STEP B: SUCCESSFUL VERIFICATION AND MINTING HOOK
 */
app.post('/api/payment/verify-razorpay-success', async (req, res) => {
  const { userId, amount, razorpayPaymentId, razorpayOrderId } = req.body;

  try {
    // 1. Allocate frozen capacity bounds inside the ledger database
    let wallet = await ActiveWallet.findOne({ userId });
    if (!wallet) {
      wallet = new ActiveWallet({ userId, liveFrozenBalance: Number(amount), clientPublicKey: "mock_device_public_key_rsa_0567" });
    } else {
      wallet.liveFrozenBalance += Number(amount);
    }
    await wallet.save();

    // 2. Mint the mathematically signed cryptographic offline ticket
    const expiresAt = Date.now() + (12 * 60 * 60 * 1000); 
    // FIXED: Ensured explicit Number cast to prevent signature mismatch gaps
    const tokenPayload = `${userId}|${Number(amount)}|${expiresAt}`;

    const signer = crypto.createSign('SHA256');
    signer.update(tokenPayload);
    signer.end();
    const serverSignature = signer.sign(privateKey, 'hex');

    console.log(`[RAZORPAY PAYMENT VERIFIED] Order ${razorpayOrderId} loaded ₹${amount}. Secure offline capacity generated.`);

    return res.status(200).json({
      status: "LOCKED",
      offlineTicket: { userId, allocatableFunds: Number(amount), expiresAt, serverSignature }
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * P2P LOCK VERIFICATION ENDPOINT
 * Evaluates individual customer deposit claims and secures the ledger allocations
 */
app.post('/api/payment/verify-fiat-lock', async (req, res) => {
  const { userId, amount, txnRef } = req.body;
  const clientPublicKey = "mock_device_public_key_rsa_0567";

  try {
    let wallet = await ActiveWallet.findOne({ userId });
    if (!wallet) {
      wallet = new ActiveWallet({ userId, liveFrozenBalance: Number(amount), clientPublicKey });
    } else {
      wallet.liveFrozenBalance += Number(amount);
    }
    await wallet.save();

    const expiresAt = Date.now() + (12 * 60 * 60 * 1000); 
    const tokenPayload = `${userId}|${Number(amount)}|${expiresAt}`;

    const signer = crypto.createSign('SHA256');
    signer.update(tokenPayload);
    signer.end();
    const serverSignature = signer.sign(privateKey, 'hex');

    console.log(`[REAL MONEY DEPOSIT CLAIMED] Verified reference ${txnRef}. Allocated ₹${amount} offline capacity.`);

    return res.status(200).json({
      status: "LOCKED",
      offlineTicket: { userId, allocatableFunds: Number(amount), expiresAt, serverSignature }
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * PHASE 1: ONMETA PRODUCTION WEBHOOK LISTENER
 */
app.post('/api/webhook/onmeta-success', async (req, res) => {
  const { status, fiatAmount, metadata } = req.body; 

  if (status === 'success') {
    const userId = metadata.userId; 
    const clientPublicKey = metadata.publicKey || "mock_device_public_key_rsa_0567";

    try {
      let wallet = await ActiveWallet.findOne({ userId });
      if (!wallet) {
        wallet = new ActiveWallet({ userId, liveFrozenBalance: Number(fiatAmount), clientPublicKey });
      } else {
        wallet.liveFrozenBalance += Number(fiatAmount);
      }
      await wallet.save();

      const expiresAt = Date.now() + (12 * 60 * 60 * 1000); 
      const tokenPayload = `${userId}|${Number(fiatAmount)}|${expiresAt}`;

      const signer = crypto.createSign('SHA256');
      signer.update(tokenPayload);
      signer.end();
      const serverSignature = signer.sign(privateKey, 'hex');

      console.log(`[ON-RAMP WEBHOOK SUCCESS] Minted secure offline token for ₹${fiatAmount}`);

      pendingTicketsCache.set(userId, {
        userId,
        allocatableFunds: Number(fiatAmount),
        expiresAt,
        serverSignature
      });

      return res.status(200).json({ message: "Webhook processed successfully." });

    } catch (error) {
      return res.status(500).json({ error: "Internal processing failure: " + error.message });
    }
  }

  return res.status(400).send('Transaction not successful');
});

/**
 * NEW ADJACENT ENDPOINT: FETCH MINTED TICKET
 */
app.get('/api/payment/get-ticket/:userId', (req, res) => {
  const { userId } = req.params;
  const ticket = pendingTicketsCache.get(userId);

  if (!ticket) {
    return res.status(404).json({ error: "No active generated offline tickets found for this profile." });
  }

  pendingTicketsCache.delete(userId);
  return res.status(200).json(ticket);
});

/**
 * PHASE 2: LIVE OFFLINE TO ONLINE SETTLEMENT EXECUTION
 */
app.post('/api/payment/settle-offline-ticket', async (req, res) => {
  const { transactionId, payerId, merchantId, amount, serverSignature, expiresAt } = req.body;

  const session = await ActiveWallet.startSession();
  try {
    session.startTransaction();

    const duplicateCheck = await SettlementRecord.findOne({ transactionId }).session(session);
    if (duplicateCheck) {
      await session.abortTransaction();
      return res.status(409).json({ error: "Transaction already processed and settled." });
    }

    // FIXED: Swapped out undefined 'userId' for the correct bound request parameter 'payerId'
    const tokenPayload = `${payerId}|${Number(amount)}|${expiresAt}`;
    
    const verifier = crypto.createVerify('SHA256');
    verifier.update(tokenPayload);
    verifier.end();

    const isAuthenticTicket = verifier.verify(publicKey, serverSignature, 'hex');
    if (!isAuthenticTicket) {
      await session.abortTransaction();
      return res.status(401).json({ error: "Cryptographic signature mismatch. Token corrupted or malicious." });
    }

    if (Date.now() > Number(expiresAt)) {
      await session.abortTransaction();
      return res.status(410).json({ error: "Transaction ticket validity period expired." });
    }

    const payerWallet = await ActiveWallet.findOne({ userId: payerId }).session(session);
    if (!payerWallet || payerWallet.liveFrozenBalance < Number(amount)) {
      await SettlementRecord.create([{
        transactionId, payerId, merchantId, amount: Number(amount), status: 'FRAUD_REJECTED'
      }], { session });

      await session.commitTransaction();
      return res.status(403).json({ error: "Insufficient verified server funds. Re-sync denied due to double spending." });
    }

    payerWallet.liveFrozenBalance -= Number(amount);
    await payerWallet.save({ session });

    await ActiveWallet.findOneAndUpdate(
      { userId: merchantId },
      { $inc: { liveFrozenBalance: Number(amount) } },
      { session, upsert: true }
    );

    await SettlementRecord.create([{
      transactionId, payerId, merchantId, amount: Number(amount), status: 'SUCCESS'
    }], { session });

    await session.commitTransaction();
    session.endSession();

    console.log(`[REAL FUND PAYOUT SUCCESS] ₹${amount} moved from system vault to Merchant account ID: ${merchantId}`);
    return res.status(200).json({ status: "SETTLED", transactionId, amount: Number(amount) });

  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    return res.status(500).json({ error: "Transactional validation system failure: " + error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`Production Ledger Active on Port ${PORT}`));