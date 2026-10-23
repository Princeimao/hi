import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
} from "react-native";
import { useEffect, useState, useCallback } from "react";
import { apiJson } from "../../src/lib/api";
import { connectWs, onEvent, sendWs } from "../../src/lib/ws";

interface Session {
  id?: string;
  pillId: string;
  projectName: string;
  agent?: string | null;
  status: string;
  finalLine: string | null;
  steps: { label: string }[];
}

export default function HomeScreen() {
  const [me, setMe] = useState<any>(null);
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  const [approvals, setApprovals] = useState<any[]>([]);
  const [onlineAgents, setOnlineAgents] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const m = await apiJson<any>("/api/me");
      setMe(m);
      if (Array.isArray(m.agentsOnline)) {
        setOnlineAgents(m.agentsOnline);
      }
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
    await connectWs();
  }, []);

  useEffect(() => {
    void loadData();

    const unsub = onEvent((ev) => {
      if (ev.type === "coding.session") {
        const s = ev.session;
        if (s) {
          setSessions((prev) => ({ ...prev, [s.pillId ?? s.id]: s }));
        }
      } else if (ev.type === "coding.session.removed") {
        setSessions((prev) => {
          const next = { ...prev };
          delete next[ev.pillId];
          return next;
        });
      } else if (ev.type === "coding.approval") {
        const approval = ev.approval;
        if (approval) {
          setApprovals((prev) => {
            if (prev.some((a) => a.requestId === approval.requestId)) return prev;
            return [approval, ...prev];
          });
        }
      } else if (ev.type === "coding.approval.dropped") {
        setApprovals((prev) => prev.filter((a) => a.requestId !== ev.requestId));
      } else if (ev.type === "agents.online") {
        if (Array.isArray(ev.agents)) setOnlineAgents(ev.agents);
      }
    });

    return unsub;
  }, [loadData]);

  function handleDecision(requestId: string, decision: "allow" | "deny", answers?: Record<string, string>) {
    sendWs({
      type: "coding.decision",
      requestId,
      decision,
      ...(answers ? { answers } : {}),
    });
    setApprovals((p) => p.filter((x) => x.requestId !== requestId));
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#8c7ae6" size="large" />
      </View>
    );
  }

  const sessionList = Object.values(sessions);

  return (
    <ScrollView
      style={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void loadData();
          }}
          tintColor="#8c7ae6"
        />
      }
    >
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Hi Companion</Text>
          <Text style={styles.sub}>{me?.displayName || me?.email || "Connected"}</Text>
        </View>
        {onlineAgents.length > 0 && (
          <View style={styles.badge}>
            <View style={styles.badgeDot} />
            <Text style={styles.badgeText}>{onlineAgents.length} Agents Online</Text>
          </View>
        )}
      </View>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.error}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => { setLoading(true); void loadData(); }}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Pending Approvals */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Desktop Approvals</Text>
        {approvals.length > 0 && (
          <View style={styles.alertCount}>
            <Text style={styles.alertCountText}>{approvals.length}</Text>
          </View>
        )}
      </View>

      {approvals.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyText}>No pending permission requests</Text>
        </View>
      ) : (
        approvals.map((a) => (
          <View key={a.requestId} style={styles.approvalCard}>
            <View style={styles.approvalHeader}>
              <Text style={styles.toolBadge}>{a.agent || a.tool || "Approval"}</Text>
              <Text style={styles.toolSub}>{a.tool}</Text>
            </View>
            <Text style={styles.commandText}>{a.command}</Text>

            {Array.isArray(a.questions) && a.questions.length > 0 && (
              <View style={styles.questionsContainer}>
                {a.questions.map((q: any, idx: number) => (
                  <View key={idx} style={{ marginBottom: 8 }}>
                    <Text style={styles.questionTitle}>{q.question}</Text>
                    {Array.isArray(q.options) && (
                      <View style={{ gap: 6, marginTop: 4 }}>
                        {q.options.map((opt: any, oidx: number) => (
                          <TouchableOpacity
                            key={oidx}
                            style={styles.optionBtn}
                            onPress={() => handleDecision(a.requestId, "allow", { [q.question]: opt.label })}
                          >
                            <Text style={styles.optionText}>{opt.label}</Text>
                            {opt.description ? <Text style={styles.optionDesc}>{opt.description}</Text> : null}
                          </TouchableOpacity>
                        ))}
                      </View>
                    )}
                  </View>
                ))}
              </View>
            )}

            <View style={styles.actionRow}>
              <TouchableOpacity
                style={styles.allowBtn}
                onPress={() => handleDecision(a.requestId, "allow")}
              >
                <Text style={styles.actionBtnText}>Allow</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.denyBtn}
                onPress={() => handleDecision(a.requestId, "deny")}
              >
                <Text style={styles.denyBtnText}>Deny</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))
      )}

      {/* Active Coding Sessions */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Active Coding Sessions</Text>
      </View>

      {sessionList.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyText}>No active coding sessions on desktop</Text>
        </View>
      ) : (
        sessionList.map((s) => (
          <View key={s.pillId || s.id} style={styles.sessionCard}>
            <View style={styles.sessionHeader}>
              <Text style={styles.sessionProject}>{s.projectName || "Desktop Project"}</Text>
              <View style={[styles.statusPill, s.status === "working" ? styles.workingPill : styles.idlePill]}>
                <Text style={styles.statusText}>{s.status}</Text>
              </View>
            </View>
            {s.finalLine ? <Text style={styles.sessionDetail}>{s.finalLine}</Text> : null}
            {Array.isArray(s.steps) && s.steps.length > 0 && (
              <Text style={styles.sessionStep}>
                Step: {s.steps[s.steps.length - 1]?.label}
              </Text>
            )}
          </View>
        ))
      )}

      {/* Connected Devices */}
      {Array.isArray(me?.devices) && me.devices.length > 0 && (
        <>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Paired Devices</Text>
          </View>
          {me.devices.map((d: any) => (
            <View key={d.id} style={styles.deviceCard}>
              <Text style={styles.deviceName}>{d.name || d.kind}</Text>
              <Text style={styles.deviceSub}>
                {d.kind} · Last active {new Date(d.lastSeenAt).toLocaleTimeString()}
              </Text>
            </View>
          ))}
        </>
      )}

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#050508", padding: 16 },
  center: { flex: 1, backgroundColor: "#050508", alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 20,
    marginTop: 8,
  },
  title: { color: "#ece9ff", fontSize: 26, fontWeight: "800", letterSpacing: -0.5 },
  sub: { color: "#8d87a8", fontSize: 13, marginTop: 2 },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(108, 92, 231, 0.15)",
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(108, 92, 231, 0.3)",
  },
  badgeDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#00cec9", marginRight: 6 },
  badgeText: { color: "#ece9ff", fontSize: 11, fontWeight: "600" },
  errorBox: {
    backgroundColor: "rgba(235, 77, 75, 0.15)",
    padding: 12,
    borderRadius: 10,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "rgba(235, 77, 75, 0.3)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  error: { color: "#ff7675", fontSize: 13, flex: 1 },
  retryBtn: { padding: 6 },
  retryText: { color: "#8c7ae6", fontWeight: "600", fontSize: 13 },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 16,
    marginBottom: 10,
  },
  sectionTitle: { color: "#ece9ff", fontSize: 16, fontWeight: "700" },
  alertCount: {
    backgroundColor: "#e84393",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
  },
  alertCountText: { color: "#fff", fontSize: 11, fontWeight: "700" },
  emptyCard: {
    backgroundColor: "#0d0b14",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.04)",
  },
  emptyText: { color: "#787291", fontSize: 13 },
  approvalCard: {
    backgroundColor: "#161320",
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "rgba(140, 122, 230, 0.2)",
  },
  approvalHeader: { flexDirection: "row", alignItems: "center", marginBottom: 8, gap: 8 },
  toolBadge: {
    backgroundColor: "rgba(108, 92, 231, 0.25)",
    color: "#a29bfe",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    fontSize: 11,
    fontWeight: "700",
  },
  toolSub: { color: "#8d87a8", fontSize: 12 },
  commandText: {
    color: "#ece9ff",
    fontFamily: "monospace",
    fontSize: 12,
    backgroundColor: "#09080e",
    padding: 10,
    borderRadius: 8,
    marginVertical: 8,
  },
  questionsContainer: { marginVertical: 8 },
  questionTitle: { color: "#ece9ff", fontSize: 13, fontWeight: "600", marginBottom: 4 },
  optionBtn: {
    backgroundColor: "#201c2e",
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
  },
  optionText: { color: "#a29bfe", fontSize: 13, fontWeight: "600" },
  optionDesc: { color: "#8d87a8", fontSize: 11, marginTop: 2 },
  actionRow: { flexDirection: "row", gap: 10, marginTop: 10 },
  allowBtn: {
    flex: 1,
    backgroundColor: "#6c5ce7",
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  denyBtn: {
    flex: 1,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  actionBtnText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  denyBtnText: { color: "#ece9ff", fontSize: 13, fontWeight: "600" },
  sessionCard: {
    backgroundColor: "#121019",
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  sessionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  sessionProject: { color: "#ece9ff", fontSize: 15, fontWeight: "600" },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12 },
  workingPill: { backgroundColor: "rgba(0, 206, 201, 0.15)" },
  idlePill: { backgroundColor: "rgba(141, 135, 168, 0.15)" },
  statusText: { color: "#a29bfe", fontSize: 11, fontWeight: "600", textTransform: "capitalize" },
  sessionDetail: { color: "#8d87a8", fontSize: 12, marginTop: 6 },
  sessionStep: { color: "#6c5ce7", fontSize: 11, marginTop: 4, fontWeight: "500" },
  deviceCard: {
    backgroundColor: "#0d0b14",
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.04)",
  },
  deviceName: { color: "#ece9ff", fontSize: 13, fontWeight: "600" },
  deviceSub: { color: "#787291", fontSize: 11, marginTop: 2 },
});