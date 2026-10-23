import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useState, useEffect } from "react";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { apiJson, setTokens, getApiUrl } from "../src/lib/api";
import { connectWs } from "../src/lib/ws";

export default function LoginScreen() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [loading, setLoading] = useState(false);
  const [apiUrl, setApiUrlState] = useState("");

  useEffect(() => {
    void getApiUrl().then(setApiUrlState);
  }, []);

  async function submit() {
    const cleanEmail = email.trim();
    if (!cleanEmail) {
      Alert.alert("Missing Email", "Please enter your email address.");
      return;
    }
    if (password.length < 8) {
      Alert.alert("Password Too Short", "Password must be at least 8 characters long.");
      return;
    }

    setLoading(true);
    try {
      const path = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const body =
        mode === "login"
          ? { email: cleanEmail, password, deviceKind: "mobile", deviceLabel: "Hi Mobile" }
          : {
              email: cleanEmail,
              password,
              displayName: cleanEmail.split("@")[0],
              deviceKind: "mobile",
              deviceLabel: "Hi Mobile",
            };
      const data = await apiJson<any>(path, { method: "POST", body: JSON.stringify(body) });
      await setTokens(data.accessToken, data.refreshToken);
      await connectWs();
      router.replace("/(tabs)/home" as any);
    } catch (e: any) {
      Alert.alert("Authentication Failed", e?.message ?? "Unable to log in");
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.card}>
        <View style={styles.iconContainer}>
          <Ionicons name="sparkles" size={28} color="#8c7ae6" />
        </View>
        <Text style={styles.title}>Hi Companion</Text>
        <Text style={styles.subtitle}>
          {mode === "login" ? "Sign in to sync with your desktop companion" : "Create an account for cloud memory sync"}
        </Text>

        <TextInput
          style={styles.input}
          placeholder="Email address"
          placeholderTextColor="#787291"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          autoCorrect={false}
        />
        <TextInput
          style={styles.input}
          placeholder="Password (min 8 characters)"
          placeholderTextColor="#787291"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
        />

        <TouchableOpacity style={styles.btn} onPress={submit} disabled={loading}>
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.btnText}>{mode === "login" ? "Log in" : "Create Account"}</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.switchMode}
          onPress={() => setMode(mode === "login" ? "register" : "login")}
        >
          <Text style={styles.link}>
            {mode === "login" ? "Don't have an account? Register" : "Already have an account? Log in"}
          </Text>
        </TouchableOpacity>

        <View style={styles.divider}>
          <View style={styles.line} />
          <Text style={styles.or}>or</Text>
          <View style={styles.line} />
        </View>

        <TouchableOpacity
          style={styles.pairBtn}
          onPress={() => router.push("/(tabs)/pair" as any)}
        >
          <Ionicons name="qr-code-outline" size={18} color="#ece9ff" style={{ marginRight: 8 }} />
          <Text style={styles.pairBtnText}>Pair with Desktop QR code</Text>
        </TouchableOpacity>

        {apiUrl ? (
          <Text style={styles.serverInfo}>Server: {apiUrl}</Text>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#050508", justifyContent: "center", padding: 20 },
  card: {
    backgroundColor: "#0d0b14",
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
  },
  iconContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(108, 92, 231, 0.15)",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    marginBottom: 12,
  },
  title: { color: "#ece9ff", fontSize: 26, fontWeight: "800", textAlign: "center", letterSpacing: -0.5 },
  subtitle: { color: "#8d87a8", fontSize: 13, textAlign: "center", marginTop: 4, marginBottom: 24 },
  input: {
    backgroundColor: "#161320",
    color: "#ece9ff",
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    fontSize: 14,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
  },
  btn: {
    backgroundColor: "#6c5ce7",
    borderRadius: 12,
    padding: 15,
    alignItems: "center",
    marginTop: 6,
    marginBottom: 14,
  },
  btnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  switchMode: { paddingVertical: 6, alignItems: "center" },
  link: { color: "#8c7ae6", fontSize: 13, fontWeight: "500" },
  divider: { flexDirection: "row", alignItems: "center", marginVertical: 18 },
  line: { flex: 1, height: 1, backgroundColor: "rgba(255, 255, 255, 0.08)" },
  or: { color: "#787291", fontSize: 12, marginHorizontal: 12 },
  pairBtn: {
    flexDirection: "row",
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderRadius: 12,
    padding: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  pairBtnText: { color: "#ece9ff", fontWeight: "600", fontSize: 14 },
  serverInfo: {
    color: "#787291",
    fontSize: 11,
    textAlign: "center",
    marginTop: 16,
    fontFamily: "monospace",
  },
});