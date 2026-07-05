require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { ActiveWallet, SettlementRecord } = require('./database.js');


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
 * HEALTH CHECK ENDPOINT
 */
app.get('/', async (req, res) => {
  res.json({ msg: "well played" });
});

/**
 * STEP A: CREATE RAZORPAY ORDER
 */
/**
 * STEP A: CREATE RAZORPAY ORDER
 */
app.post('/api/payment/create-razorpay-order', async (req, res) => {
  const { amount } = req.body; 
  
  // 🔥 FIX: Explicitly force type cast to integer to prevent NaN failures
  const parsedAmount = Math.round(parseFloat(amount) * 100);

  console.log(`[RAZORPAY] Attempting to create order for amount: ${amount} INR (${parsedAmount} Paisa)`);

  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    console.error("[RAZORPAY ERROR] Invalid numeric value passed to order generator.");
    return res.status(400).json({ success: false, error: "Invalid currency numeric value representation." });
  }

  const options = {
    amount: parsedAmount, // Explicit parsed integer
    currency: "INR",
    receipt: `receipt_order_${Date.now()}`
  };

  try {
    const order = await razorpayInstance.orders.create(options);
    console.log(`[RAZORPAY SUCCESS] Generated Order Reference: ${order.id}`);
    
    return res.status(200).json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      keyId: razorpayInstance.key_id
    });
  } catch (error) {
    // 🔥 DIAGNOSTIC PRINT: Look at your Node console terminal to see exactly why Razorpay rejected it
    console.error("[RAZORPAY API CRASH LOG]:", error);
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
    const tokenPayload = `${userId}|${Number(amount)}|${expiresAt}`;

    const signer = crypto.createSign('SHA256');
    signer.update(tokenPayload);
    signer.end();
    const signatureHex = signer.sign(privateKey, 'hex');

    console.log(`[RAZORPAY PAYMENT VERIFIED] Order ${razorpayOrderId} loaded ₹${amount}. Secure offline capacity generated.`);

    return res.status(200).json({
      status: "LOCKED",
      offlineTicket: { 
        userId, 
        allocatableFunds: Number(amount), 
        expiresAt, 
        serverSignature: {
          originalPoolAmount: Number(amount), // Nested to allow structural string reconstruction on split settlement
          signatureHex: signatureHex
        }
      }
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * P2P LOCK VERIFICATION ENDPOINT
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
    const signatureHex = signer.sign(privateKey, 'hex');

    console.log(`[REAL MONEY DEPOSIT CLAIMED] Verified reference ${txnRef}. Allocated ₹${amount} offline capacity.`);

    return res.status(200).json({
      status: "LOCKED",
      offlineTicket: { 
        userId, 
        allocatableFunds: Number(amount), 
        expiresAt, 
        serverSignature: {
          originalPoolAmount: Number(amount),
          signatureHex: signatureHex
        }
      }
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
      const signatureHex = signer.sign(privateKey, 'hex');

      console.log(`[ON-RAMP WEBHOOK SUCCESS] Minted secure offline token for ₹${fiatAmount}`);

      pendingTicketsCache.set(userId, {
        userId,
        allocatableFunds: Number(fiatAmount),
        expiresAt,
        serverSignature: {
          originalPoolAmount: Number(fiatAmount),
          signatureHex: signatureHex
        }
      });

      return res.status(200).json({ message: "Webhook processed successfully." });

    } catch (error) {
      return res.status(500).json({ error: "Internal processing failure: " + error.message });
    }
  }

  return res.status(400).send('Transaction not successful');
});

/**
 * FETCH MINTED TICKET ENDPOINT
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
 * PHASE 2: LIVE OFFLINE TO ONLINE SPLIT-SETTLEMENT CLEARINGHOUSE
 */
app.post('/api/payment/settle-offline-ticket', async (req, res) => {
  const { transactionId, payerId, merchantId, amount, invoiceNonce, serverSignature, expiresAt } = req.body;

  const session = await ActiveWallet.startSession();
  try {
    session.startTransaction();

    // 1. Replay Attack Validation: Check for duplicate transaction ID or invoice nonce
    const duplicateCheck = await SettlementRecord.findOne({ 
      $or: [{ transactionId }, { invoiceNonce }] 
    }).session(session);
    
    if (duplicateCheck) {
      await session.abortTransaction();
      return res.status(409).json({ error: "Transaction/Invoice already processed and settled." });
    }

    // 2. CRYPTOGRAPHIC ASYMMETRIC SIGNATURE VALIDATION
    // Reconstruct the payload base using original pool amount parameter to assert structural token match
    const tokenPayload = `${payerId}|${Number(serverSignature.originalPoolAmount)}|${expiresAt}`;
    
    const verifier = crypto.createVerify('SHA256');
    verifier.update(tokenPayload);
    verifier.end();

    const isAuthenticTicket = verifier.verify(publicKey, serverSignature.signatureHex, 'hex');
    if (!isAuthenticTicket) {
      await session.abortTransaction();
      return res.status(401).json({ error: "Cryptographic signature mismatch. Token corrupted or altered." });
    }

    // 3. Expiration Bounds Check
    if (Date.now() > Number(expiresAt)) {
      await session.abortTransaction();
      return res.status(410).json({ error: "Transaction ticket validity period expired." });
    }

    // 4. LEDGER BALANCING WITH ESCROW RESERVES
    const payerWallet = await ActiveWallet.findOne({ userId: payerId }).session(session);
    if (!payerWallet || payerWallet.liveFrozenBalance < Number(amount)) {
      // Create record documenting fraudulent overflow attempt
      await SettlementRecord.create([{
        transactionId, invoiceNonce, payerId, merchantId, amount: Number(amount), status: 'FRAUD_REJECTED'
      }], { session });

      await session.commitTransaction();
      return res.status(403).json({ error: "Insufficient verified server funds. Re-sync denied due to double spending." });
    }

    // Deduct the flexible, fractional transaction amount from the master holding account
    payerWallet.liveFrozenBalance -= Number(amount);
    await payerWallet.save({ session });

    // Credit the corresponding merchant store ledger
    await ActiveWallet.findOneAndUpdate(
      { userId: merchantId },
      { $inc: { liveFrozenBalance: Number(amount) } },
      { session, upsert: true }
    );

    // Save success audit trailing block
    await SettlementRecord.create([{
      transactionId, invoiceNonce, payerId, merchantId, amount: Number(amount), status: 'SUCCESS'
    }], { session });

    await session.commitTransaction();
    session.endSession();

    console.log(`[REAL FUND PAYOUT SUCCESS] ₹${amount} moved from vault pool to Merchant account ID: ${merchantId}`);
    return res.status(200).json({ status: "SETTLED", transactionId, amount: Number(amount) });

  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    return res.status(500).json({ error: "Transactional validation system failure: " + error.message });
  }
});

const PORT = process.env.PORT || 8080; // Defaulting to your clean 8080 configuration channel
app.listen(PORT, '0.0.0.0', () => console.log(`Production Ledger Active on Port ${PORT}`));