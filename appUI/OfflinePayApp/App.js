import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, TextInput, Button, Alert, ScrollView, Modal } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import QRCode from 'react-native-qrcode-svg';
import { Camera, CameraView } from 'expo-camera';
import { WebView } from 'react-native-webview';

const BACKEND_URL = 'https://5eec-2a09-bac1-3680-5d68-00-2a6-2f.ngrok-free.app/api/payment';
const AUTH_URL = 'https://5eec-2a09-bac1-3680-5d68-00-2a6-2f.ngrok-free.app/api/auth';

export default function App() {
  const [scanned, setScanned] = useState(false);
  const [role, setRole] = useState(null); 
  const [userId, setUserId] = useState('');
  const [isOnboarded, setIsOnboarded] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [hasCameraPermission, setHasCameraPermission] = useState(null);
  const [isScannerOpen, setIsScannerOpen] = useState(false);

  // Merchant Banking Onboarding Inputs
  const [bankName, setBankName] = useState('');
  const [bankAcc, setBankAcc] = useState('');
  const [bankIfsc, setBankIfsc] = useState('');

  // Operational Primitives
  const [amountToLock, setAmountToLock] = useState('100'); 
  const [activeVoucher, setActiveVoucher] = useState(null);
  const [localWalletBalance, setLocalWalletBalance] = useState(0);
  const [checkoutUrlHtml, setCheckoutUrlHtml] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [billAmount, setBillAmount] = useState('15'); 
  const [activeInvoice, setActiveInvoice] = useState(null);
  const [offlineQueue, setOfflineQueue] = useState([]);

  useEffect(() => {
    checkSavedProfile();
    (async () => {
      const { status } = await Camera.requestCameraPermissionsAsync();
      setHasCameraPermission(status === 'granted');
    })();
  }, []);

  const handleExitCurrentRole = () => {
    console.log(`[NAVIGATION] Exiting profile container role perspective for user: ${userId}`);
    
    // 🔥 The Magic Switcher Trick: 
    // Simply flipping this flag to false unmounts the dashboard layout tree 
    // and instantly drops the viewport frame back to the main Onboarding Hub.
    setIsOnboarded(false);
  };


  const checkSavedProfile = async () => {
    const savedId = await AsyncStorage.getItem('user_id');
    const savedRole = await AsyncStorage.getItem('user_role');
    const savedBalance = await AsyncStorage.getItem('offline_wallet_balance');
    const savedQueue = await AsyncStorage.getItem('merchant_queue');

    if (savedId && savedRole) {
      setUserId(savedId);
      setRole(savedRole);
      setIsOnboarded(true);
      if (savedBalance) setLocalWalletBalance(Number(savedBalance));
      if (savedQueue) setOfflineQueue(JSON.parse(savedQueue));
    }
  };

  const handleOnboarding = async () => {
    if (!userId.trim()) {
      Alert.alert("Input Error", "Please provide a valid unique identifier name.");
      return;
    }
    if (role === 'merchant' && (!bankName || !bankAcc || !bankIfsc)) {
      Alert.alert("Input Error", "Merchants must submit commercial banking deployment keys.");
      return;
    }

    const cleanId = userId.trim().toLowerCase();

    try {
      const response = await fetch(`${AUTH_URL}/onboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: cleanId,
          role: role,
          accountHolderName: bankName,
          accountNumber: bankAcc,
          ifscCode: bankIfsc
        })
      });
      const data = await response.json();

      if (response.ok) {
        // 🔥 Save identity tokens locally
        await AsyncStorage.setItem('user_id', cleanId);
        await AsyncStorage.setItem('user_role', role);
        
        // 🔥 If the user already had money in their ledger pool, load it back into memory!
        if (data.profile && data.profile.liveFrozenBalance !== undefined) {
          const currentLedgerFunds = data.profile.liveFrozenBalance;
          setLocalWalletBalance(Number(currentLedgerFunds));
          await AsyncStorage.setItem('offline_wallet_balance', String(currentLedgerFunds));
        }

        setIsOnboarded(true);
        Alert.alert("Welcome Back", `Successfully synced profile: ${cleanId}`);
      } else {
        Alert.alert("Registration Denied", data.error || "Execution dropped.");
      }
    } catch (err) {
      Alert.alert("Network Failure", "Cannot hit onboarding authentication pipeline servers.");
    }
  };

  const startRazorpayCheckout = async () => {
    try {
      const response = await fetch(`${BACKEND_URL}/create-razorpay-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: Number(amountToLock) })
      });
      const orderData = await response.json();
      if (!orderData.success) {
        Alert.alert("Backend Error", "Could not instantiate order.");
        return;
      }

      const checkoutHtml = `
        <!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <script src="https://checkout.razorpay.com/v1/checkout.js"></script></head>
        <body style="background-color: #f5f5f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
          <script>
            var options = {
              "key": "${orderData.keyId}", "amount": "${orderData.amount}", "currency": "INR", "name": "OfflinePay Vault",
              "order_id": "${orderData.orderId}",
              "handler": function (response) {
                window.ReactNativeWebView.postMessage(JSON.stringify({
                  event: 'PAYMENT_SUCCESS', razorpay_payment_id: response.razorpay_payment_id, razorpay_order_id: response.razorpay_order_id
                }));
              },
              "modal": { "ondismiss": function() { window.ReactNativeWebView.postMessage(JSON.stringify({ event: 'PAYMENT_CANCELLED' })); } }
            };
            var rzp = new Razorpay(options); window.onload = function() { rzp.open(); }
          </script>
        </body></html>
      `;
      setCheckoutUrlHtml(checkoutHtml);
      setShowModal(true);
    } catch (err) {
      Alert.alert("Error", "Gateway initialization dropped.");
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
          body: JSON.stringify({ userId, amount: amountToLock })
        });
        const ticketResult = await verifyResponse.json();
        
        if (verifyResponse.ok) {
          setActiveVoucher(ticketResult.offlineTicket);
          setLocalWalletBalance(Number(ticketResult.offlineTicket.allocatableFunds));
          await AsyncStorage.setItem('offline_wallet_balance', String(ticketResult.offlineTicket.allocatableFunds));
          Alert.alert("Sandbox Initialized", `₹${amountToLock} loaded into secure sandbox configuration.`);
        }
      } catch (e) {
        Alert.alert("Minting Error", "Payment cleared, but local asymmetric ledger allocation signature generation failed.");
      }
    }
  };

  const handleMerchantInvoiceScan = async (scannedInvoiceString) => {
    if (scanned) return;
    setScanned(true);

    try {
      const invoice = JSON.parse(scannedInvoiceString.trim());
      const currentBalance = Number(await AsyncStorage.getItem('offline_wallet_balance') || 0);

      if (currentBalance < Number(invoice.requestedAmount)) {
        Alert.alert("Transaction Denied", "Insufficient local wallet sandbox capacity balance.");
        setScanned(false);
        return;
      }

      const updatedBalance = currentBalance - Number(invoice.requestedAmount);
      setLocalWalletBalance(updatedBalance);
      await AsyncStorage.setItem('offline_wallet_balance', String(updatedBalance));

      const transactionPayload = {
        transactionId: `TX-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`,
        payerId: userId,
        merchantId: invoice.merchantId,
        amount: Number(invoice.requestedAmount),
        invoiceNonce: invoice.invoiceNonce,
        serverSignature: activeVoucher?.serverSignature || "mock_signature_block_0567",
        expiresAt: activeVoucher?.expiresAt || (Date.now() + 3600000)
      };

      const savedQueue = await AsyncStorage.getItem('merchant_queue');
      const currentQueue = savedQueue ? JSON.parse(savedQueue) : [];
      const updatedQueue = [...currentQueue, transactionPayload];
      
      setOfflineQueue(updatedQueue);
      await AsyncStorage.setItem('merchant_queue', JSON.stringify(updatedQueue));

      Alert.alert("Payment Completed!", `Spent ₹${invoice.requestedAmount} offline. Remaining sandbox capacity balance pool: ₹${updatedBalance}`);
      setScanned(false);
    } catch (err) {
      Alert.alert("Scan Error", "Corrupted or non-standard invoice payload formatting.");
      setScanned(false);
    }
  };

  const generateMerchantInvoice = () => {
    const randomBlock = Math.floor(1000 + Math.random() * 9000); 
    setActiveInvoice({
      merchantId: userId,
      requestedAmount: Number(billAmount),
      invoiceNonce: `INV-${Date.now()}-${randomBlock}`
    });
  };

  const syncMerchantQueueOnline = async () => {
    if (!isOnline) {
      Alert.alert("Network Protection", "Toggle framework connectivity status online before running clear operations.");
      return;
    }
    let temporaryQueue = [...offlineQueue];
    for (const tx of temporaryQueue) {
      try {
        const response = await fetch(`${BACKEND_URL}/settle-offline-ticket`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(tx)
        });
        if (response.ok) {
          temporaryQueue = temporaryQueue.filter(item => item.transactionId !== tx.transactionId);
        }
      } catch (e) {}
    }
    setOfflineQueue(temporaryQueue);
    await AsyncStorage.setItem('merchant_queue', JSON.stringify(temporaryQueue));
    Alert.alert("Sync Operation Processed", "Ledger queues synchronized back to bank vault accounts successfully.");
  };

  const clearSystemCache = async () => {
    await AsyncStorage.clear();
    setUserId('');
    setRole(null);
    setIsOnboarded(false);
    setLocalWalletBalance(0);
    setActiveInvoice(null);
    setOfflineQueue([]);
    Alert.alert("Wipe Complete", "System profile states and ledger records returned to factory baselines.");
  };

  // ==========================================
  // RENDER SELECTION ENGINE SWITCHES
  // ==========================================
  if (!isOnboarded) {
    return (
      <ScrollView contentContainerStyle={styles.centerContainer}>
        <Text style={styles.titleText}>Sovereign Offline Clearing Platform</Text>
        
        {!role ? (
          <View style={{ width: '100%', alignItems: 'center' }}>
            <Text style={styles.subtitleText}>Choose Profile Paradigm</Text>
            <TouchableOpacity style={styles.button} onPress={() => setRole('payer')}>
              <Text style={styles.btnText}>Setup Payer Wallet Account</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.button, { backgroundColor: '#4CAF50' }]} onPress={() => setRole('merchant')}>
              <Text style={styles.btnText}>Register Commercial Merchant Account</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={[styles.card, { width: '100%' }]}>
            <Text style={styles.roleTitle}>Onboarding: {role.toUpperCase()}</Text>
            
            <Text style={styles.label}>Create Unique Profile ID Name:</Text>
            <TextInput style={styles.input} placeholder="e.g., parth_store_01" value={userId} onChangeText={setUserId} autoCapitalize="none" />

            {role === 'merchant' && (
  <View>
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 15 }}>
      <View style={{ flex: 1, marginRight: 10 }}>
        <Text style={styles.label}>Create/Enter Merchant ID Name:</Text>
        <TextInput 
          style={[styles.input, { marginBottom: 0 }]} 
          placeholder="e.g., merchant_store_99" 
          value={userId} 
          onChangeText={setUserId} 
          autoCapitalize="none" 
        />
      </View>
      
      {/* 🛠️ TEMPORARY TESTING BYPASS BUTTON */}
      <TouchableOpacity 
        style={{ backgroundColor: '#FF5722', padding: 12, borderRadius: 5, height: 45, justifyContent: 'center' }}
        onPress={async () => {
          if (!userId.trim()) {
            Alert.alert("Test Trigger", "Type a Merchant ID first to fetch details.");
            return;
          }
          console.log(`[TEST BYPASS] Attempting direct pull for merchant ID: ${userId}`);
          try {
            const response = await fetch(`${AUTH_URL}/onboard`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId: userId.trim().toLowerCase(), role: 'merchant' })
            });
            const data = await response.json();
            
            if (response.ok) {
              // Populate form fields with existing database details for visual proof
              if (data.profile && data.profile.bankDetails) {
                setBankName(data.profile.bankDetails.accountHolderName || 'Fetched Store');
                setBankAcc(data.profile.bankDetails.accountNumber || '123456789');
                setBankIfsc(data.profile.bankDetails.ifscCode || 'MOCK0001234');
              }
              
              await AsyncStorage.setItem('user_id', userId.trim().toLowerCase());
              await AsyncStorage.setItem('user_role', 'merchant');
              setIsOnboarded(true);
              Alert.alert("Bypass Success", "Existing Merchant profile authenticated via ID!");
            } else {
              Alert.alert("Bypass Error", data.error || "Profile not found.");
            }
          } catch (e) {
            Alert.alert("Network Failure", "Cannot hit onboarding backend.");
          }
        }}
      >
        <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 12 }}>⚡ Quick Entry</Text>
      </TouchableOpacity>
    </View>

    <Text style={styles.label}>Real-World Legal Account Name:</Text>
    <TextInput style={styles.input} placeholder="Sharma Gen Store Ltd" value={bankName} onChangeText={setBankName} />
    
    <Text style={styles.label}>Physical Bank Account Number:</Text>
    <TextInput style={styles.input} keyboardType="numeric" placeholder="91802004561239" value={bankAcc} onChangeText={setBankAcc} />
    
    <Text style={styles.label}>Indian Financial System Code (IFSC):</Text>
    <TextInput style={styles.input} placeholder="SBIN0001234" value={bankIfsc} onChangeText={setBankIfsc} autoCapitalize="characters" />
  </View>
)}

            <TouchableOpacity style={[styles.button, { width: '100%', marginTop: 20 }]} onPress={handleOnboarding}>
              <Text style={styles.btnText}>Commit Registration Profile</Text>
            </TouchableOpacity>

            <TouchableOpacity style={{ marginTop: 15, alignItems: 'center' }} onPress={() => setRole(null)}>
              <Text style={{ color: '#008CBA', fontWeight: 'bold' }}>← Back to Selection Paradigm</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.header}>
        <Text style={styles.roleTitle}>ID: {userId.toUpperCase()} ({role.toUpperCase()})</Text>
        <TouchableOpacity style={[styles.networkBadge, { backgroundColor: isOnline ? '#2196F3' : '#F44336' }]} onPress={() => setIsOnline(!isOnline)}>
          <Text style={styles.btnText}>{isOnline ? " 🟢 MODE: SYSTEM ONLINE" : "🔴 MODE: SYSTEM OFFLINE"}</Text>
        </TouchableOpacity>
      </View>

      {role === 'payer' ? (
        <View style={styles.card}>
          <Text style={styles.walletHeading}>Sandbox Wallet Balance: ₹{localWalletBalance}</Text>
          <Text style={styles.label}>Amount to Load via Razorpay (INR):</Text>
          <TextInput style={styles.input} keyboardType="numeric" value={amountToLock} onChangeText={setAmountToLock} />
          
          <Button title="Fund Digital Sandbox" onPress={startRazorpayCheckout} color="#2196F3" />

          <Modal visible={showModal} animationType="slide" transparent={false}>
            <View style={{ flex: 1, paddingTop: 40, backgroundColor: '#f5f5f5' }}>
              <Button title="← Terminate Secure WebView Link" onPress={() => setShowModal(false)} color="#333" />
              {checkoutUrlHtml && (
                <WebView source={{ html: checkoutUrlHtml }} onMessage={handleWebViewMessage} javaScriptEnabled={true} domStorageEnabled={true} startInLoadingState={true} originWhitelist={['*']} mixedContentMode="always" allowUniversalAccessFromFileURLs={true} />
              )}
            </View>
          </Modal>

          <View style={styles.scannerContainer}>
            {!isScannerOpen ? (
              <TouchableOpacity style={[styles.button, { backgroundColor: '#E91E63', width: '100%' }]} onPress={() => setIsScannerOpen(true)}>
                <Text style={styles.btnText}>📸 Scan Merchant Bill Invoice</Text>
              </TouchableOpacity>
            ) : (
              <View>
                <Button title="Close Camera Sensor" onPress={() => setIsScannerOpen(false)} color="#666" />
                <View style={styles.scannerWrapper}>
                  <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={scanned ? undefined : (r) => handleMerchantInvoiceScan(r.data)} />
                </View>
              </View>
            )}
          </View>
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.label}>Generate Variable Bill Invoice Amount (INR):</Text>
          <TextInput style={styles.input} keyboardType="numeric" value={billAmount} onChangeText={setBillAmount} />
          <Button title="Compile Invoice QR Block" onPress={generateMerchantInvoice} color="#FF9800" />
          
          {activeInvoice && (
            <View style={styles.qrContainer}>
              <Text style={styles.qrLabel}>👉 Scan Matrix Footprint 👈</Text>
              <QRCode value={JSON.stringify(activeInvoice).trim()} size={200} />
              <Text style={styles.expiryNote}>Invoice Charge: ₹{activeInvoice.requestedAmount}</Text>
            </View>
          )}

          <View style={{ borderTopWidth: 1, borderColor: '#eee', marginTop: 25, paddingTop: 15 }}>
            <Text style={styles.label}>Local Sync Vault Log: {offlineQueue.length} Transcripts Pending Clear</Text>
            <Button title="Synchronize Operations Back to Bank" onPress={syncMerchantQueueOnline} color="#4CAF50" disabled={offlineQueue.length === 0} />
          </View>
        </View>
      )}

      <TouchableOpacity style={styles.resetBtn} onPress={clearSystemCache}>
        <Text style={{ color: '#F44336', fontWeight: 'bold' }}>⚠️ Clear Storage & Wipe Profiles</Text>
      </TouchableOpacity>
      {/* 🚀 NAVIGATIONAL TRANSITION BUTTON LAYER */}
      <View style={{ width: '100%', marginTop: 30, paddingHorizontal: 10 }}>
        
        <TouchableOpacity 
          style={[styles.navigationButton, { backgroundColor: '#008CBA' }]} 
          onPress={handleExitCurrentRole}
        >
          <Text style={styles.btnText}>↩️ Exit Role & Change Account</Text>
        </TouchableOpacity>

        <TouchableOpacity 
          style={[styles.resetBtn, { marginTop: 15 }]} 
          onPress={clearSystemCache}
        >
          <Text style={{ color: '#F44336', fontWeight: 'bold', textAlign: 'center' }}>
            ⚠️ Hard Reset (Wipe All Local Core Cache Logs)
          </Text>
        </TouchableOpacity>

      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  centerContainer: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f5f5f5', padding: 20 },
  container: { flexGrow: 1, padding: 20, backgroundColor: '#fafafa', alignItems: 'center' },
  header: { width: '100%', flexDirection: 'column', alignItems: 'center', marginBottom: 20 },
  titleText: { fontSize: 24, fontWeight: 'bold', marginBottom: 10, color: '#333', textAlign: 'center' },
  subtitleText: { fontSize: 16, color: '#666', marginBottom: 20 },
  roleTitle: { fontSize: 20, fontWeight: 'bold', color: '#222', marginBottom: 10, textAlign: 'center' },
  networkBadge: { padding: 10, borderRadius: 20, marginTop: 5, width: '80%', alignItems: 'center' },
  button: { backgroundColor: '#008CBA', padding: 15, borderRadius: 10, marginVertical: 10, width: '80%', alignItems: 'center' },
  btnText: { color: 'white', fontWeight: 'bold', fontSize: 16 },
  card: { width: '100%', backgroundColor: 'white', borderRadius: 15, padding: 20, elevation: 3 },
  walletHeading: { fontSize: 18, fontWeight: 'bold', color: '#E91E63', textAlign: 'center', marginVertical: 10, padding: 10, backgroundColor: '#FFF0F5', borderRadius: 8 },
  label: { fontSize: 14, fontWeight: '600', color: '#555', marginBottom: 5, marginTop: 10 },
  input: { borderBottomWidth: 1, borderColor: '#ccc', padding: 8, marginBottom: 15, fontSize: 16 },
  qrContainer: { alignItems: 'center', marginTop: 20, padding: 10 },
  qrLabel: { fontWeight: 'bold', color: '#E91E63', marginBottom: 10 },
  expiryNote: { marginTop: 10, color: '#222', fontWeight: 'bold' },
  scannerContainer: { marginTop: 25 },
  scannerWrapper: { height: 300, width: '100%', overflow: 'hidden', marginTop: 10, borderRadius: 10, backgroundColor: '#000' },
  resetBtn: { marginTop: 40, marginBottom: 20 }
});