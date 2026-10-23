import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
  TextInput,
  TouchableOpacity,
} from "react-native";
import { useEffect, useState, useCallback } from "react";
import { Ionicons } from "@expo/vector-icons";
import { apiJson } from "../../src/lib/api";

interface Friend {
  id: string;
  name: string;
  address?: string;
  readme?: string;
  agentStatus: string;
  lastMessage?: string | null;
  lastMessageAt?: string | null;
}

export default function FriendsScreen() {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [discoverResults, setDiscoverResults] = useState<any[]>([]);

  const loadFriends = useCallback(async () => {
    try {
      const list = await apiJson<Friend[]>("/api/friends");
      setFriends(list);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load friends");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadFriends();
  }, [loadFriends]);

  async function handleDiscover() {
    if (!search.trim()) {
      setDiscoverResults([]);
      return;
    }
    setDiscovering(true);
    try {
      const results = await apiJson<any[]>(`/api/friends/discover?q=${encodeURIComponent(search.trim())}`);
      setDiscoverResults(results ?? []);
    } catch {
      setDiscoverResults([]);
    } finally {
      setDiscovering(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#8c7ae6" size="large" />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void loadFriends();
          }}
          tintColor="#8c7ae6"
        />
      }
    >
      <Text style={styles.title}>Agentverse Friends</Text>
      <Text style={styles.sub}>
        External AI agents connected to your multi-agent ecosystem.
      </Text>

      {/* Discover Agentverse search */}
      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search Agentverse agents..."
          placeholderTextColor="#787291"
          value={search}
          onChangeText={setSearch}
          onSubmitEditing={handleDiscover}
          returnKeyType="search"
        />
        <TouchableOpacity style={styles.searchBtn} onPress={handleDiscover}>
          {discovering ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Ionicons name="search" size={18} color="#fff" />
          )}
        </TouchableOpacity>
      </View>

      {discoverResults.length > 0 && (
        <View style={styles.discoverSection}>
          <Text style={styles.sectionTitle}>Discovered Agents</Text>
          {discoverResults.map((r, i) => (
            <View key={r.address || i} style={styles.discoverCard}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>{r.name || "Agent"}</Text>
                <View style={styles.statusBadge}>
                  <Text style={styles.statusText}>{r.status || "active"}</Text>
                </View>
              </View>
              {r.readme ? (
                <Text style={styles.cardReadme} numberOfLines={2}>
                  {r.readme}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      )}

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.error}>{error}</Text>
        </View>
      )}

      <Text style={styles.sectionTitle}>Connected Friends</Text>
      {friends.length === 0 ? (
        <View style={styles.emptyCard}>
          <Ionicons name="people-outline" size={36} color="#2b2740" />
          <Text style={styles.emptyTitle}>No Friends Connected</Text>
          <Text style={styles.empty}>
            You haven't connected with any external Agentverse agents yet. Search above to discover agents!
          </Text>
        </View>
      ) : (
        friends.map((f) => (
          <View key={f.id} style={styles.card}>
            <View style={styles.cardHeader}>
              <View style={styles.avatarMini}>
                <Ionicons name="hardware-chip-outline" size={16} color="#8c7ae6" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>{f.name}</Text>
                <Text style={styles.cardSub}>
                  {f.agentStatus === "active" ? "Online" : f.agentStatus}
                </Text>
              </View>
              <View
                style={[
                  styles.statusBadge,
                  f.agentStatus === "active" ? styles.statusActive : styles.statusIdle,
                ]}
              >
                <Text style={styles.statusText}>{f.agentStatus}</Text>
              </View>
            </View>
            {f.lastMessage && (
              <Text style={styles.lastMsg} numberOfLines={2}>
                "{f.lastMessage}"
              </Text>
            )}
          </View>
        ))
      )}

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#050508", padding: 16 },
  center: { flex: 1, backgroundColor: "#050508", alignItems: "center", justifyContent: "center" },
  title: { color: "#ece9ff", fontSize: 24, fontWeight: "700", marginBottom: 4 },
  sub: { color: "#8d87a8", fontSize: 13, marginBottom: 16 },
  searchRow: { flexDirection: "row", gap: 8, marginBottom: 16 },
  searchInput: {
    flex: 1,
    backgroundColor: "#121019",
    color: "#ece9ff",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 13,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
  },
  searchBtn: {
    backgroundColor: "#6c5ce7",
    width: 44,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  discoverSection: { marginBottom: 16 },
  discoverCard: {
    backgroundColor: "#161322",
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "rgba(108, 92, 231, 0.2)",
  },
  cardReadme: { color: "#8d87a8", fontSize: 11, marginTop: 4 },
  sectionTitle: { color: "#ece9ff", fontSize: 16, fontWeight: "600", marginBottom: 10 },
  card: {
    backgroundColor: "#121019",
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  avatarMini: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: "rgba(108, 92, 231, 0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: { color: "#ece9ff", fontSize: 15, fontWeight: "600" },
  cardSub: { color: "#8d87a8", fontSize: 11, marginTop: 2 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  statusActive: { backgroundColor: "rgba(0, 206, 201, 0.15)" },
  statusIdle: { backgroundColor: "rgba(141, 135, 168, 0.15)" },
  statusText: { color: "#a29bfe", fontSize: 11, fontWeight: "600", textTransform: "capitalize" },
  lastMsg: { color: "#8d87a8", fontSize: 12, marginTop: 8, fontStyle: "italic" },
  emptyCard: {
    backgroundColor: "#0d0b14",
    borderRadius: 12,
    padding: 24,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.04)",
  },
  emptyTitle: { color: "#ece9ff", fontSize: 15, fontWeight: "600", marginTop: 10, marginBottom: 4 },
  empty: { color: "#787291", fontSize: 12, textAlign: "center", lineHeight: 18 },
  errorBox: {
    backgroundColor: "rgba(235, 77, 75, 0.15)",
    padding: 12,
    borderRadius: 10,
    marginBottom: 12,
  },
  error: { color: "#ff7675", fontSize: 13 },
});