import { View, Text, StyleSheet, TouchableOpacity, Alert } from "react-native";
import { useEffect, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import { disconnectWs } from "../../src/lib/ws";
import { clearTokens as clearTok, getApiUrl, apiJson } from "../../src/lib/api";
import { useRouter } from "expo-router";

export default function SettingsScreen() {
  const router = useRouter();
  const [apiUrl, setApiUrlState] = useState("");
  const [me, setMe] = useState<any>(null);

  useEffect(() => {
    void getApiUrl().then(setApiUrlState);
    void apiJson<any>("/api/me").then(setMe).catch(() => null);
  }, []);

  async function logout() {
    Alert.alert("Log Out", "Are you sure you want to log out from this companion?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Log Out",
        style: "destructive",
        onPress: async () => {
          await clearTok();
          disconnectWs();
          router.replace("/login" as any);
        },
      },
    ]);
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Settings</Text>

      {/* User profile card */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.userIcon}>
            <Ionicons name="person" size={20} color="#8c7ae6" />
          </View>
          <View>
            <Text style={styles.cardTitle}>{me?.displayName || "Hi User"}</Text>
            <Text style={styles.cardSub}>{me?.email || "Local companion session"}</Text>
          </View>
        </View>
      </View>

      {/* Connection info */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Server Connection</Text>
        <Text style={styles.infoLabel}>Backend URL</Text>
        <Text style={styles.infoValue}>{apiUrl || "Not configured"}</Text>
        <TouchableOpacity style={styles.pairLink} onPress={() => router.push("/(tabs)/pair" as any)}>
          <Ionicons name="qr-code-outline" size={16} color="#8c7ae6" style={{ marginRight: 6 }} />
          <Text style={styles.pairLinkText}>Change server or re-pair desktop</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={styles.logoutBtn} onPress={logout}>
        <Ionicons name="log-out-outline" size={18} color="#ff7675" style={{ marginRight: 8 }} />
        <Text style={styles.logoutBtnText}>Log out</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#050508", padding: 16 },
  title: { color: "#ece9ff", fontSize: 24, fontWeight: "700", marginBottom: 16 },
  card: {
    backgroundColor: "#121019",
    borderRadius: 14,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
  userIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(108, 92, 231, 0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: { color: "#ece9ff", fontSize: 16, fontWeight: "600" },
  cardSub: { color: "#8d87a8", fontSize: 12, marginTop: 2 },
  sectionTitle: { color: "#ece9ff", fontSize: 14, fontWeight: "600", marginBottom: 10 },
  infoLabel: { color: "#787291", fontSize: 11, marginBottom: 2 },
  infoValue: { color: "#ece9ff", fontSize: 13, fontFamily: "monospace", marginBottom: 12 },
  pairLink: { flexDirection: "row", alignItems: "center", marginTop: 4 },
  pairLinkText: { color: "#8c7ae6", fontSize: 13, fontWeight: "500" },
  logoutBtn: {
    flexDirection: "row",
    backgroundColor: "rgba(235, 77, 75, 0.12)",
    borderRadius: 12,
    padding: 14,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(235, 77, 75, 0.25)",
    marginTop: 10,
  },
  logoutBtnText: { color: "#ff7675", fontWeight: "600", fontSize: 14 },
});