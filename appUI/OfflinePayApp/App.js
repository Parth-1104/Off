import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, TextInput, Button, Alert, ScrollView, Modal } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import QRCode from 'react-native-qrcode-svg';
import { Camera, CameraView } from 'expo-camera';
import { WebView } from 'react-native-webview';
import { v4 as uuidv4 } from 'uuid';

// Handshakes across Wi-Fi/Hotspot network directly with your Mac IP address
const BACKEND_URL = 'https://5eec-2a09-bac1-3680-5d68-00-2a6-2f.ngrok-free.app/api/payment';

export default function App() {
  const [scanned, setScanned] = useState(false);
  const [role, setRole] = useState(null); 
  const [isOnline, setIsOnline] = useState(true);
  const [hasCameraPermission, setHasCameraPermission] = useState(null);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  
  // Payer State Primitives
  const [userId, setUserId] = useState('payer_parth_01');
  const [amountToLock, setAmountToLock] = useState('100'); // Higher pool amount default for splitting
  const [activeVoucher, setActiveVoucher] = useState(null); // Holds core server credentials/signature
  const [localWalletBalance, setLocalWalletBalance] = useState(0); // Tracks real-time offline sandbox spendability
  
  // Razorpay WebView Interface States
  const [checkoutUrlHtml, setCheckoutUrlHtml] = useState(null);
  const [showModal, setShowModal] = useState(false);
  
  // Merchant State Primitives
  const [merchantId] = useState('merchant_store_99');
  const [billAmount, setBillAmount] = useState('15'); // Custom variable pricing input
  const [activeInvoice, setActiveInvoice] = useState(null);
  const [offlineQueue, setOfflineQueue] = useState([]);

  useEffect(() => {
    loadOfflineQueueAndWallet();
    (async () => {
      const { status } = await Camera.requestCameraPermissionsAsync();
      setHasCameraPermission(status === 'granted');
    })();
  }, []);

  const loadOfflineQueueAndWallet = async () => {
    const savedQueue = await AsyncStorage.getItem('merchant_queue');
    if (savedQueue) setOfflineQueue(JSON.parse(savedQueue));

    const savedBalance = await AsyncStorage.getItem('offline_wallet_balance');
    if (savedBalance) setLocalWalletBalance(Number(savedBalance));
    
    const savedVoucher = await AsyncStorage.getItem('active_voucher_token');
    if (savedVoucher) setActiveVoucher(JSON.parse(savedVoucher));
  };

  // ==========================================
  // RAZORPAY EMBEDDED WEB CHECKOUT FLOW
  // ==========================================
  const startRazorpayCheckout = async () => {
    console.log(`[DIAGNOSTIC] startRazorpayCheckout entered. Current isOnline status flag evaluates to: ${isOnline}`);
  
    // 🔥 TEMPORARY DIAGNOSTIC OVERRIDE: 
    // Comment out the strict online gate check completely while debugging to force the engine forward
    /*
    if (!isOnline) {
      console.warn("[CHECKOUT BLOCKED] System is in simulation offline mode constraint layout.");
      Alert.alert("Error", "You must be online to load funds via Razorpay.");
      return;
    }
    */
  
    console.log(`[NETWORK RUNTIME] Preparing connection request link. Hitting: ${BACKEND_URL}/create-razorpay-order`);
    
    try {
      const response = await fetch(`${BACKEND_URL}/create-razorpay-order`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ amount: Number(amountToLock) })
      });
      
      console.log(`[NETWORK RESPONSE STATUS]: ${response.status}`);
      const orderData = await response.json();
      console.log("[NETWORK RESPONSE BODY DATA]:", orderData);
  
      if (!orderData.success) {
        console.error("[ORDER CHECK FAILURE] Order initialization initialization flag returned false.");
        Alert.alert("Backend Error", `Gateway Refused: ${orderData.error || 'Unknown error'}`);
        return;
      }
  
      // 🚀 Your original script injection html generation block
      const checkoutHtml = `
        <!DOCTYPE html>
        <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
          </head>
          <body style="background-color: #f5f5f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
            <script>
              var options = {
                "key": "${orderData.keyId}",
                "amount": "${orderData.amount}",
                "currency": "INR",
                "name": "OfflinePay System Pool",
                "order_id": "${orderData.orderId}",
                "handler": function (response) {
                  window.ReactNativeWebView.postMessage(JSON.stringify({
                    event: 'PAYMENT_SUCCESS',
                    razorpay_payment_id: response.razorpay_payment_id,
                    razorpay_order_id: response.razorpay_order_id
                  }));
                },
                "modal": { "ondismiss": function() { window.ReactNativeWebView.postMessage(JSON.stringify({ event: 'PAYMENT_CANCELLED' })); } },
                "theme": { "color": "#2196F3" }
              };
              var rzp = new Razorpay(options);
              window.onload = function() { rzp.open(); }
            </script>
          </body>
        </html>
      `;
  
      console.log("[STATE CONTROLLER] HTML payload string compiled. Pushing to WebKit mounting layout tree...");
      setCheckoutUrlHtml(checkoutHtml);
      setShowModal(true);
  
    } catch (err) {
      console.error("[CRITICAL FAILURE] Target endpoint could not be reached. Error trace stack:", err);
      Alert.alert("Connection Failure", `Unable to reach backend gateway server: ${err.message}`);
    }
  };

  const handleWebViewMessage = async (event) => {
    const data = JSON.parse(event.nativeEvent.data);
    setShowModal(false);

    if (data.event === 'PAYMENT_SUCCESS') {
      try {
        const verifyResponse = await fetch(`${BACKEND_URL}/verify-razorpay-success`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: userId,
            amount: amountToLock,
            razorpayPaymentId: data.razorpay_payment_id,
            razorpayOrderId: data.razorpay_order_id
          })
        });
        const ticketResult = await verifyResponse.json();
        
        if (verifyResponse.ok) {
          // Initialize the Local Wallet Sandbox
          setActiveVoucher(ticketResult.offlineTicket);
          setLocalWalletBalance(Number(ticketResult.offlineTicket.allocatableFunds));
          
          await AsyncStorage.setItem('active_voucher_token', JSON.stringify(ticketResult.offlineTicket));
          await AsyncStorage.setItem('offline_wallet_balance', String(ticketResult.offlineTicket.allocatableFunds));
          
          Alert.alert("Sandbox Loaded!", `₹${amountToLock} verified. On-device sandbox wallet initialized.`);
        } else {
          Alert.alert("Minting Failure", ticketResult.error || "Failed to process signatures.");
        }
      } catch (e) {
        Alert.alert("Minting Error", "Payment succeeded, but local cryptographic issuance failed.");
      }
    } else {
      Alert.alert("Cancelled", "Transaction checkout canceled by the operator.");
    }
  };

  // ==========================================
  // CUSTOMER FLOW: SCANS MERCHANT INVOICE
  // ==========================================
  const handleMerchantInvoiceScan = async (scannedInvoiceString) => {
    if (scanned) return;
    setScanned(true);

    try {
      let cleanString = scannedInvoiceString.trim();
      if (cleanString.startsWith('"') && cleanString.endsWith('"')) {
        cleanString = cleanString.slice(1, -1);
      }

      const invoice = JSON.parse(cleanString);
      const currentBalance = Number(await AsyncStorage.getItem('offline_wallet_balance') || 0);

      // Validation: Check local sandbox allowance limits
      if (currentBalance < Number(invoice.requestedAmount)) {
        Alert.alert("Transaction Denied", "Insufficient funds in your on-device sandbox.", [
          { text: "OK", onPress: () => setScanned(false) }
        ]);
        return;
      }

      if (!activeVoucher || !activeVoucher.serverSignature) {
        Alert.alert("Auth Error", "No active cryptographic voucher certificate found.", [
          { text: "OK", onPress: () => setScanned(false) }
        ]);
        return;
      }

      // 1. Local Ledger Sandbox Update (Deduct spending chunk)
      const updatedBalance = currentBalance - Number(invoice.requestedAmount);
      setLocalWalletBalance(updatedBalance);
      await AsyncStorage.setItem('offline_wallet_balance', String(updatedBalance));

      // 2. Build Fractional Cryptographic Receipt Payload
      const transactionPayload = {
        // Inside handleMerchantInvoiceScan:
transactionId: `TX-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`,
        payerId: userId,
        merchantId: invoice.merchantId,
        amount: Number(invoice.requestedAmount),
        invoiceNonce: invoice.invoiceNonce,
        serverSignature: activeVoucher.serverSignature, // Core signature passed forward
        expiresAt: activeVoucher.expiresAt
      };

      if (!isOnline) {
        // Online Simulation Hook: In production this transmission payload is shared locally via QR back to merchant,
        // Bluetooth, or NFC. For this single-app structural model, we save it directly to the merchant queue state log.
        const savedQueue = await AsyncStorage.getItem('merchant_queue');
        const currentQueue = savedQueue ? JSON.parse(savedQueue) : [];
        const updatedQueue = [...currentQueue, transactionPayload];
        
        setOfflineQueue(updatedQueue);
        await AsyncStorage.setItem('merchant_queue', JSON.stringify(updatedQueue));

        Alert.alert(
          "Payment Successful!", 
          `Spent ₹${invoice.requestedAmount} offline.\nRemaining Sandbox Pool: ₹${updatedBalance}`,
          [{ text: "Done", onPress: () => setScanned(false) }]
        );
      } else {
        // If customer is online during testing, push straight through to server clearinghouse
        await processSettlementOnServer(transactionPayload);
        setScanned(false);
      }

    } catch (err) {
      Alert.alert("Scan Error", "Invalid Merchant Invoice layout configuration.", [
        { text: "Try Again", onPress: () => setScanned(false) }
      ]);
    }
  };

  // ==========================================
  // MERCHANT FLOW: GENERATE INVOICE & SYNC
  // ==========================================
  const generateMerchantInvoice = () => {
    const randomBlock = Math.floor(1000 + Math.random() * 9000); 
    const uniqueNonce = `INV-${Date.now()}-${randomBlock}`;
  
    const invoicePayload = {
      merchantId: merchantId,
      requestedAmount: Number(billAmount),
      invoiceNonce: uniqueNonce
    };
    setActiveInvoice(invoicePayload);
  };

  const processSettlementOnServer = async (payload) => {
    try {
      const response = await fetch(`${BACKEND_URL}/settle-offline-ticket`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'ngrok-skip-browser-warning': 'true'
        },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (response.ok) {
        Alert.alert("Funds Settled", `Success! ₹${payload.amount} fractional asset moved to your account vault.`);
        return true;
      } else {
        Alert.alert("Settlement Refused", data.error);
        return false;
      }
    } catch (err) {
      Alert.alert("Server Error", "Unable to establish contact with live settlement backend.");
      return false;
    }
  };

  const syncMerchantQueueOnline = async () => {
    if (!isOnline) {
      Alert.alert("Action Blocked", "Connect your device back online before starting sync operations.");
      return;
    }
    let temporaryQueue = [...offlineQueue];
    for (const tx of temporaryQueue) {
      const successfullySettled = await processSettlementOnServer(tx);
      if (successfullySettled) {
        temporaryQueue = temporaryQueue.filter(item => item.transactionId !== tx.transactionId);
      }
    }
    setOfflineQueue(temporaryQueue);
    await AsyncStorage.setItem('merchant_queue', JSON.stringify(temporaryQueue));
  };

  const clearWalletData = async () => {
    await AsyncStorage.removeItem('offline_wallet_balance');
    await AsyncStorage.removeItem('active_voucher_token');
    setLocalWalletBalance(0);
    setActiveVoucher(null);
    Alert.alert("Reset Complete", "Local sandbox environment wiped clean.");
  };

  // ==========================================
  // RENDERING LAYOUT ENGINE
  // ==========================================
  if (!role) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.titleText}>Select Operational Framework Profile</Text>
        <TouchableOpacity style={styles.button} onPress={() => setRole('payer')}>
          <Text style={styles.btnText}>I am the Payer (Customer)</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.button, { backgroundColor: '#4CAF50' }]} onPress={() => setRole('merchant')}>
          <Text style={styles.btnText}>I am the Merchant (Shopkeeper)</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.header}>
        <Text style={styles.roleTitle}>Profile: {role.toUpperCase()}</Text>
        <TouchableOpacity 
          style={[styles.networkBadge, { backgroundColor: isOnline ? '#2196F3' : '#F44336' }]} 
          onPress={() => setIsOnline(!isOnline)}
        >
          <Text style={styles.btnText}>{isOnline ? " 🟢 SIMULATING ONLINE" : "🔴 SIMULATING OFFLINE"}</Text>
        </TouchableOpacity>
      </View>

     {role === 'payer' ? (
  <View style={styles.card}>
    <Text style={styles.walletHeading}>On-Device Sandbox Balance: ₹{localWalletBalance}</Text>
    
    <Text style={styles.label}>Payer Registration ID:</Text>
    <TextInput style={styles.input} value={userId} onChangeText={setUserId} />
    
    <Text style={styles.label}>Amount to Fund Pool (INR):</Text>
    <TextInput style={styles.input} keyboardType="numeric" value={amountToLock} onChangeText={setAmountToLock} />
    
    <Button 
      title="Fund via Razorpay" 
      onPress={() => {
        console.log(`[UI ACTION] 'Fund via Razorpay' pressed. Input amount: ${amountToLock}`);
        startRazorpayCheckout();
      }} 
      color="#2196F3" 
    />
    
    <View style={{ marginTop: 10 }}>
      <Button 
        title="Wipe Local Wallet Cache" 
        onPress={() => {
          console.log("[UI ACTION] Wiping wallet cache storage triggered.");
          clearWalletData();
        }} 
        color="#F44336" 
      />
    </View>

    {/* DIAGNOSTIC CHECK: Replaced previous baseline structure with a strict, non-race condition lifecycle rendering guard */}
    <Modal 
      visible={showModal} 
      animationType="slide" 
      transparent={false}
      onRequestClose={() => {
        console.log("[MODAL] Hardware back button requested close layout state.");
        setShowModal(false);
      }}
    >
      <View style={{ flex: 1, paddingTop: 40, backgroundColor: '#f5f5f5' }}>
        <View style={{ paddingHorizontal: 15, marginBottom: 10 }}>
          <Button 
            title="← Cancel & Go Back" 
            onPress={() => {
              console.log("[UI ACTION] Modal close manual layout override pressed.");
              setShowModal(false);
            }} 
            color="#333" 
          />
        </View>
        
        {/* TELEMETRY RENDER STEP: Verifies that HTML payload string array exists before initializing inner WebKit component */}
        {checkoutUrlHtml ? (
          <WebView 
            source={{ html: checkoutUrlHtml }}
            onMessage={(e) => {
              console.log("[WEBVIEW] Ingestion message frame arrived from Razorpay HTML script context.");
              handleWebViewMessage(e);
            }}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            startInLoadingState={true}
            originWhitelist={['*']}
            mixedContentMode="always"
            allowUniversalAccessFromFileURLs={true}
            style={{ flex: 1 }}
            onLoadStart={() => console.log("[WEBVIEW LIFECYCLE] Native frame loading operation initiated...")}
            onLoadEnd={() => console.log("[WEBVIEW LIFECYCLE] HTML payload bundle parsing operation completed smoothly.")}
            onError={(syntheticEvent) => {
              const { nativeEvent } = syntheticEvent;
              console.error("[WEBVIEW CRITICAL FAILURE ERROR]:", nativeEvent);
            }}
          />
        ) : (
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <Text style={{ color: '#666', fontSize: 16 }}>Establishing secure payment gateway stream...</Text>
          </View>
        )}
      </View>
    </Modal>

    {/* CONTROL ARCHITECTURE: Only allow scanning if the wallet has been funded */}
    <View style={styles.scannerContainer}>
      {localWalletBalance > 0 ? (
        !isScannerOpen ? (
          <TouchableOpacity 
            style={[styles.button, { backgroundColor: '#E91E63', width: '100%' }]} 
            onPress={() => {
              console.log("[UI ACTION] Scanner view request interface opened.");
              setScanned(false);
              setIsScannerOpen(true);
            }}
          >
            <Text style={styles.btnText}>📷 Open Camera Scanner</Text>
          </TouchableOpacity>
        ) : (
          <View>
            <TouchableOpacity 
              style={{ backgroundColor: '#666', padding: 10, borderRadius: 5, marginBottom: 10, alignItems: 'center' }} 
              onPress={() => {
                console.log("[UI ACTION] Scanner manually retracted.");
                setIsScannerOpen(false);
              }}
            >
              <Text style={{ color: '#fff', fontWeight: 'bold' }}>Close Scanner Camera</Text>
            </TouchableOpacity>

            <View style={styles.scannerWrapper}>
              {hasCameraPermission === false ? (
                <Text style={styles.scannerText}>Camera permissions denied.</Text>
              ) : (
                <CameraView
                  style={{ flex: 1 }}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={scanned ? undefined : (result) => {
                    if (result.data) {
                      console.log(`[SCANNER SUCCESS] Ingested raw QR footprint matrix string: ${result.data}`);
                      setIsScannerOpen(false);
                      handleMerchantInvoiceScan(result.data);
                    }
                  }}
                />
              )}
            </View>
          </View>
        )
      ) : (
        <View style={{ padding: 15, backgroundColor: '#FFF3CD', borderRadius: 8, marginTop: 15 }}>
          <Text style={{ color: '#856404', textAlign: 'center', fontWeight: '500' }}>
            ⚠️ Wallet Sandbox empty. Load funds via Razorpay above to unlock the offline checkout scanner interface.
          </Text>
        </View>
      )}
    </View>
  </View>
) : (
        <View style={styles.card}>
          <Text style={styles.label}>Enter Variable Bill Amount (INR):</Text>
          <TextInput style={styles.input} keyboardType="numeric" value={billAmount} onChangeText={setBillAmount} />
          
          <Button title="Generate Invoice QR" onPress={generateMerchantInvoice} color="#FF9800" />
          
          {activeInvoice && (
            <View style={styles.qrContainer}>
              <Text style={styles.qrLabel}>👉 Present this Invoice to Customer 👈</Text>
              <QRCode 
                value={typeof activeInvoice === 'string' ? activeInvoice : JSON.stringify(activeInvoice).trim()} 
                size={200} 
              />
              <Text style={styles.expiryNote}>Charge Request: ₹{activeInvoice.requestedAmount}</Text>
            </View>
          )}

          <View style={{ borderTopWidth: 1, borderColor: '#eee', marginTop: 25, paddingTop: 15 }}>
            <Text style={styles.label}>Collected Queue Log: {offlineQueue.length} Vouchers Pending Sync</Text>
            <Button title="Sync Queue Back to Bank" onPress={syncMerchantQueueOnline} color="#4CAF50" disabled={offlineQueue.length === 0} />
          </View>
        </View>
      )}

      <TouchableOpacity style={styles.resetBtn} onPress={() => setRole(null)}>
        <Text style={{ color: '#888' }}>Exit Profile Role Selection</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  centerContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f5f5f5', padding: 20 },
  container: { flexGrow: 1, padding: 20, backgroundColor: '#fafafa', alignItems: 'center' },
  header: { width: '100%', flexDirection: 'column', alignItems: 'center', marginBottom: 20, marginTop: 20 },
  titleText: { fontSize: 22, fontWeight: 'bold', marginBottom: 30, color: '#333', textAlign: 'center' },
  roleTitle: { fontSize: 24, fontWeight: 'bold', color: '#222' },
  networkBadge: { padding: 10, borderRadius: 20, marginTop: 10, width: '80%', alignItems: 'center' },
  button: { backgroundColor: '#008CBA', padding: 15, borderRadius: 10, marginVertical: 10, width: '80%', alignItems: 'center' },
  btnText: { color: 'white', fontWeight: 'bold', fontSize: 16 },
  card: { width: '100%', backgroundColor: 'white', borderRadius: 15, padding: 20, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 10, elevation: 3 },
  walletHeading: { fontSize: 18, fontWeight: 'bold', color: '#E91E63', textAlign: 'center', marginVertical: 10, padding: 10, backgroundColor: '#FFF0F5', borderRadius: 8 },
  label: { fontSize: 14, fontWeight: '600', color: '#555', marginBottom: 5, marginTop: 10 },
  input: { borderBottomWidth: 1, borderColor: '#ccc', padding: 8, marginBottom: 15, fontSize: 16 },
  qrContainer: { alignItems: 'center', marginTop: 20, padding: 10 },
  qrLabel: { fontWeight: 'bold', color: '#E91E63', marginBottom: 10, textAlign: 'center' },
  expiryNote: { marginTop: 10, color: '#222', fontWeight: 'bold' },
  scannerContainer: { marginTop: 25, borderTopWidth: 1, borderColor: '#eee', paddingTop: 15 },
  scannerWrapper: { height: 300, width: '100%', overflow: 'hidden', marginTop: 10, borderRadius: 10, backgroundColor: '#000', justifyContent: 'center' },
  scannerText: { textAlign: 'center', padding: 20, color: '#fff' },
  resetBtn: { marginTop: 40, marginBottom: 20 }
});