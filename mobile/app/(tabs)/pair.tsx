import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert, Platform, ActivityIndicator } from "react-native";
import { useState, useEffect } from "react";
import { CameraView, useCameraPermissions } from "expo-camera";
import { getApiUrl, setApiUrl, setTokens } from "../../src/lib/api";
import { connectWs } from "../../src/lib/ws";
import { useRouter } from "expo-router";

export default function PairScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void getApiUrl().then((u) => {
      if (u) setUrl(u);
    });
  }, []);

  async function startScan() {
    if (Platform.OS === "web") {
      Alert.alert("Camera scan", "QR scanning is available on native devices. Please enter connection details below.");
      return;
    }
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) {
        Alert.alert("Permission needed", "Camera permission is required to scan the desktop pairing QR code.");
        return;
      }
    }
    setScanned(false);
    setScanning(true);
  }

  async function handleScan({ data }: { data: string }) {
    if (scanned) return;
    setScanned(true);
    setScanning(false);
    try {
      const parsed = JSON.parse(data);
      if (parsed.apiUrl) await setApiUrl(parsed.apiUrl);
      if (parsed.accessToken) {
        await setTokens(parsed.accessToken, parsed.refreshToken || parsed.accessToken);
      }
      await connectWs();
      Alert.alert("Paired", "Connected to desktop companion successfully.");
      router.replace("/(tabs)/home" as any);
    } catch {
      Alert.alert("Invalid QR", "Could not parse desktop pairing QR code. Please check that you scanned the QR code from the desktop companion.");
    } finally {
      setTimeout(() => setScanned(false), 2000);
    }
  }

  async function saveManual() {
    if (!url.trim()) {
      Alert.alert("Missing URL", "Please enter the backend URL (e.g. http://192.168.1.10:8787)");
      return;
    }
    setSaving(true);
    try {
      await setApiUrl(url.trim());
      if (token.trim()) {
        await setTokens(token.trim(), token.trim());
        await connectWs();
        Alert.alert("Saved", "Connection details saved.");
        router.replace("/(tabs)/home" as any);
      } else {
        Alert.alert("URL Saved", "Backend address updated. You can now log in or scan desktop QR.");
      }
    } catch (e: any) {
      Alert.alert("Error", e?.message ?? "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Pair with Desktop</Text>
      <Text style={styles.desc}>
        Open Hi on your PC, click "Pair phone" or the QR code in settings, then scan it with your camera.
      </Text>

      {scanning ? (
        <View style={styles.scannerWrapper}>
          <CameraView
            style={StyleSheet.absoluteFill}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={scanned ? undefined : handleScan}
          />
          <View style={styles.overlayFrame} />
          <TouchableOpacity style={styles.cancel} onPress={() => setScanning(false)}>
            <Text style={styles.btnText}>Cancel scanner</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.content}>
          {Platform.OS !== "web" ? (
            <TouchableOpacity style={styles.scanBtn} onPress={startScan}>
              <Text style={styles.scanBtnText}>Scan pairing QR code</Text>
            </TouchableOpacity>
          ) : (
            <Text style={styles.notice}>QR scanning is available on iOS/Android; enter server details below.</Text>
          )}

          <View style={styles.divider}>
            <View style={styles.line} />
            <Text style={styles.or}>or enter manually</Text>
            <View style={styles.line} />
          </View>

          <Text style={styles.label}>Backend URL</Text>
          <TextInput
            style={styles.input}
            placeholder="http://192.168.1.x:8787"
            placeholderTextColor="#787291"
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={styles.label}>Access Token (optional if logging in)</Text>
          <TextInput
            style={styles.input}
            placeholder="Paste token or pair payload"
            placeholderTextColor="#787291"
            value={token}
            onChangeText={setToken}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <TouchableOpacity style={styles.saveBtn} onPress={saveManual} disabled={saving}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnText}>Save connection</Text>}
          </TouchableOpacity>

          <TouchableOpacity style={styles.loginLink} onPress={() => router.push("/login" as any)}>
            <Text style={styles.loginLinkText}>Have an account? Log in with email & password</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#050508", padding: 20 },
  title: { color: "#ece9ff", fontSize: 24, fontWeight: "700", marginBottom: 6 },
  desc: { color: "#8d87a8", fontSize: 13, lineHeight: 18, marginBottom: 20 },
  scannerWrapper: { flex: 1, borderRadius: 16, overflow: "hidden", position: "relative" },
  overlayFrame: {
    position: "absolute",
    top: "25%",
    left: "15%",
    right: "15%",
    height: 240,
    borderWidth: 2,
    borderColor: "#8c7ae6",
    borderRadius: 16,
    backgroundColor: "transparent",
  },
  cancel: {
    position: "absolute",
    bottom: 24,
    left: 24,
    right: 24,
    backgroundColor: "#1f1d2b",
    borderRadius: 12,
    padding: 14,
    alignItems: "center",
  },
  content: { flex: 1 },
  scanBtn: {
    backgroundColor: "#6c5ce7",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    marginBottom: 8,
  },
  scanBtnText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  notice: { color: "#8d87a8", fontSize: 13, marginBottom: 12, textAlign: "center" },
  divider: { flexDirection: "row", alignItems: "center", marginVertical: 18 },
  line: { flex: 1, height: 1, backgroundColor: "rgba(255, 255, 255, 0.08)" },
  or: { color: "#787291", fontSize: 12, marginHorizontal: 12 },
  label: { color: "#ece9ff", fontSize: 12, fontWeight: "600", marginBottom: 6 },
  input: {
    backgroundColor: "#121019",
    color: "#ece9ff",
    borderRadius: 10,
    padding: 12,
    marginBottom: 14,
    fontSize: 14,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
  },
  saveBtn: {
    backgroundColor: "#2b2740",
    borderRadius: 12,
    padding: 14,
    alignItems: "center",
    marginTop: 6,
    marginBottom: 16,
  },
  saveBtnText: { color: "#ece9ff", fontWeight: "600", fontSize: 14 },
  loginLink: { padding: 8, alignItems: "center" },
  loginLinkText: { color: "#8c7ae6", fontSize: 13, fontWeight: "500" },
  btnText: { color: "#ece9ff", fontWeight: "600", fontSize: 14 },
});