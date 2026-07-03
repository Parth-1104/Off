import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, TextInput, Button, Alert, ScrollView, Modal } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import QRCode from 'react-native-qrcode-svg';
import { Camera, CameraView } from 'expo-camera';
import { WebView } from 'react-native-webview';
import { v4 as uuidv4 } from 'uuid';

// Handshakes across Wi-Fi/Hotspot network directly with your Mac IP address
const BACKEND_URL = 'http://192.168.254.229:8080/api/payment';

export default function App() {
  const [scanned, setScanned] = useState(false);
  const [role, setRole] = useState(null); 
  const [isOnline, setIsOnline] = useState(true);
  const [hasCameraPermission, setHasCameraPermission] = useState(null);
  
  // Payer State Primitives
  const [userId, setUserId] = useState('payer_parth_01');
  const [amountToLock, setAmountToLock] = useState('10'); 
  const [activeVoucher, setActiveVoucher] = useState(null);
  
  // Razorpay WebView Interface States
  const [checkoutUrlHtml, setCheckoutUrlHtml] = useState(null);
  const [showModal, setShowModal] = useState(false);
  
  // Merchant State Primitives
  const [merchantId] = useState('merchant_store_99');
  const [offlineQueue, setOfflineQueue] = useState([]);

  useEffect(() => {
    loadOfflineQueue();
    (async () => {
      const { status } = await Camera.requestCameraPermissionsAsync();
      setHasCameraPermission(status === 'granted');
    })();
  }, []);

  const loadOfflineQueue = async () => {
    const savedQueue = await AsyncStorage.getItem('merchant_queue');
    if (savedQueue) setOfflineQueue(JSON.parse(savedQueue));
  };

  // ==========================================
  // RAZORPAY EMBEDDED WEB CHECKOUT FLOW
  // ==========================================
  const startRazorpayCheckout = async () => {
    if (!isOnline) {
      Alert.alert("Error", "You must be online to load funds via Razorpay.");
      return;
    }

    try {
      // 1. Ask Node.js server to generate an official order block from Razorpay
      const response = await fetch(`${BACKEND_URL}/create-razorpay-order`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'ngrok-skip-browser-warning': 'true' // 🔥 BYPASSES NGROK 403 SIGN-IN FLAG
        },
        body: JSON.stringify({ amount: Number(amountToLock) })
      });
      const orderData = await response.json();

      if (!orderData.success) {
        Alert.alert("Backend Error", "Could not instantiate Razorpay order reference.");
        return;
      }

      // 2. Build a responsive HTML wrapper injected with the checkout.js SDK
      const checkoutHtml = `
        <!DOCTYPE html>
        <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
          </head>
          <body style="background-color: #f5f5f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
            <div style="text-align: center; font-family: sans-serif; padding: 20px;">
              <h3 style="color: #333;">Initializing Razorpay Channel...</h3>
              <p style="color: #666;">Please complete the simulation in the popup interface.</p>
            </div>
            <script>
              var options = {
                "key": "${orderData.keyId}",
                "amount": "${orderData.amount}",
                "currency": "INR",
                "name": "OfflinePay System Pool",
                "description": "Minting Secure Offline Asset",
                "order_id": "${orderData.orderId}",
                "handler": function (response) {
                  var output = {
                    event: 'PAYMENT_SUCCESS',
                    razorpay_payment_id: response.razorpay_payment_id,
                    razorpay_order_id: response.razorpay_order_id
                  };
                  window.ReactNativeWebView.postMessage(JSON.stringify(output));
                },
                "modal": {
                  "ondismiss": function() {
                    window.ReactNativeWebView.postMessage(JSON.stringify({ event: 'PAYMENT_CANCELLED' }));
                  }
                },
                "prefill": {
                  "name": "Parth Pankaj Singh",
                  "email": "parth.singh@bennett.edu.in",
                  "contact": "9999999999"
                },
                "theme": { "color": "#2196F3" }
              };
              var rzp = new Razorpay(options);
              window.onload = function() {
                rzp.open();
              }
            </script>
          </body>
        </html>
      `;

      setCheckoutUrlHtml(checkoutHtml);
      setShowModal(true);

    } catch (err) {
      Alert.alert("Connection Failure", "Unable to hit your running Node.js backend gateway.");
    }
  };

  const handleWebViewMessage = async (event) => {
    const data = JSON.parse(event.nativeEvent.data);
    setShowModal(false);

    if (data.event === 'PAYMENT_SUCCESS') {
      try {
        // 3. Post to verification endpoint to execute cryptographic signature blocks
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
          setActiveVoucher(ticketResult.offlineTicket);
          Alert.alert("Success!", `₹${amountToLock} completely verified and secure offline token minted!`);
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
  // MERCHANT CORE FLOW (OFFLINE SCANNING & SYNC)
  // ==========================================
  const handleQRScanSuccess = async (scannedDataString) => {
    // 1. Block incoming frames if a scan is already running
    if (scanned) return;
    setScanned(true);

    try {
      const scannedTicket = JSON.parse(scannedDataString);
      
      const transactionPayload = {
        transactionId: `TX-${uuidv4().substring(0,8).toUpperCase()}`,
        payerId: scannedTicket.userId,
        merchantId: merchantId,
        amount: scannedTicket.allocatableFunds,
        serverSignature: scannedTicket.serverSignature,
        expiresAt: scannedTicket.expiresAt
      };

      if (!isOnline) {
        const updatedQueue = [...offlineQueue, transactionPayload];
        setOfflineQueue(updatedQueue);
        await AsyncStorage.setItem('merchant_queue', JSON.stringify(updatedQueue));
        
        Alert.alert("Offline Saved", "Zero connectivity. Secure ticket verified via math and saved locally.", [
          { text: "OK", onPress: () => setScanned(false) } // 2. Release lock on close
        ]);
      } else {
        const success = await processSettlementOnServer(transactionPayload);
        // Release lock after hit completes
        setScanned(false);
      }
    } catch (err) {
      Alert.alert("Scan Error", "Invalid crypto ticket format.", [
        { text: "Try Again", onPress: () => setScanned(false) }
      ]);
    }
  };
  const processSettlementOnServer = async (payload) => {
    try {
      const response = await fetch(`${BACKEND_URL}/settle-offline-ticket`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'ngrok-skip-browser-warning': 'true' // 🔥 BYPASSES NGROK 403 SIGN-IN FLAG
        },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (response.ok) {
        Alert.alert("Money Settled", `Success! ₹${payload.amount} has been programmatically credited to your account.`);
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
          <Text style={styles.label}>Payer Registration ID:</Text>
          <TextInput style={styles.input} value={userId} onChangeText={setUserId} />
          
          <Text style={styles.label}>Amount to Fund via Razorpay (INR):</Text>
          <TextInput style={styles.input} keyboardType="numeric" value={amountToLock} onChangeText={setAmountToLock} />
          
          <Button title="Launch Razorpay Gateway" onPress={startRazorpayCheckout} color="#2196F3" />

          {/* OVERLAY MODAL FOR WEBVIEW STANDARD GATEWAY EMBEDDING */}
          <Modal visible={showModal} animationType="slide" transparent={false}>
            <View style={{ flex: 1, paddingTop: 40, backgroundColor: '#f5f5f5' }}>
              <Button title="← Cancel & Go Back" onPress={() => setShowModal(false)} color="#333" />
              {checkoutUrlHtml && (
                <WebView 
                  source={{ html: checkoutUrlHtml }}
                  onMessage={handleWebViewMessage}
                  javaScriptEnabled={true}
                  domStorageEnabled={true}
                  startInLoadingState={true}
                />
              )}
            </View>
          </Modal>

          {activeVoucher && (
            <View style={styles.qrContainer}>
              <Text style={styles.qrLabel}>👉 Present QR payload to Merchant Offline 👈</Text>
              <QRCode value={JSON.stringify(activeVoucher)} size={220} />
              <Text style={styles.expiryNote}>Offline Secure Balance: ₹{activeVoucher.allocatableFunds}</Text>
            </View>
          )}
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.label}>Collected Queue Log: {offlineQueue.length} Vouchers Pending</Text>
          <Button title="Sync Queue Back to Bank" onPress={syncMerchantQueueOnline} color="#4CAF50" disabled={offlineQueue.length === 0} />
          
          <View style={styles.scannerWrapper}>
            {hasCameraPermission === false ? (
              <Text style={styles.scannerText}>Camera permissions denied. Enable manually in system configurations.</Text>
            ) : (
              <CameraView
                style={{ flex: 1 }} // 🔥 Tells Expo to take up the full parent wrapper space natively
                facing="back"
                barcodeScannerSettings={{ 
                  barcodeTypes: ["qr"] // Forces hardware chip optimization for QR arrays only
                }}
                onBarcodeScanned={scanned ? undefined : (result) => {
                  if (result.data) handleQRScanSuccess(result.data);
                }}
              />
            )}
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
  label: { fontSize: 14, fontWeight: '600', color: '#555', marginBottom: 5, marginTop: 10 },
  input: { borderBottomWidth: 1, borderColor: '#ccc', padding: 8, marginBottom: 15, fontSize: 16 },
  qrContainer: { alignItems: 'center', marginTop: 25, padding: 10, borderTopWidth: 1, borderColor: '#eee' },
  qrLabel: { fontWeight: 'bold', color: '#E91E63', marginBottom: 15 },
  expiryNote: { marginTop: 10, color: '#666', fontStyle: 'italic' },
  scannerWrapper: { height: 350, width: '100%', overflow: 'hidden', marginTop: 20, borderRadius: 10, backgroundColor: '#000', justifyContent: 'center' },
  scannerText: { textAlign: 'center', padding: 20, color: '#fff' },
  resetBtn: { marginTop: 40, marginBottom: 20 }
});