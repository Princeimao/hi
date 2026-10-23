import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Modal,
} from "react-native";
import { useEffect, useState, useRef } from "react";
import { Ionicons } from "@expo/vector-icons";
import { apiJson } from "../../src/lib/api";
import { connectWs, onEvent, sendWs } from "../../src/lib/ws";

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  clientMessageId?: string;
  meta?: {
    streaming?: boolean;
    source?: string;
  };
  createdAt?: string;
}

interface Conversation {
  id: string;
  title: string;
  createdAt?: string;
}

export default function ChatScreen() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [active, setActive] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [avatarState, setAvatarState] = useState<string>("idle");
  const [selectorVisible, setSelectorVisible] = useState(false);
  const flatListRef = useRef<FlatList>(null);
  const activeIdRef = useRef<string | null>(null);

  activeIdRef.current = active?.id ?? null;

  useEffect(() => {
    void (async () => {
      try {
        await connectWs();
        const list = await apiJson<Conversation[]>("/api/conversations");
        setConversations(list);
        if (list.length > 0) {
          await openConversation(list[0]);
        }
      } catch (err) {
        console.warn("[chat] failed to load conversations:", err);
      } finally {
        setLoading(false);
      }
    })();

    const unsub = onEvent((ev) => {
      if (ev.type === "conversation.created") {
        const conv = ev.conversation;
        if (conv?.id) {
          setConversations((prev) => [conv, ...prev.filter((c) => c.id !== conv.id)]);
          if (!activeIdRef.current) {
            setActive(conv);
          }
        }
      } else if (ev.type === "chat.message") {
        const msg = ev.message;
        if (!msg?.id) return;
        setMessages((prev) => {
          const idx = prev.findIndex(
            (m) => m.id === msg.id || (msg.clientMessageId && m.clientMessageId === msg.clientMessageId)
          );
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { ...next[idx], ...msg, meta: { ...next[idx].meta, ...msg.meta } };
            return next;
          }
          return [...prev, msg];
        });
      } else if (ev.type === "chat.delta") {
        const { messageId, text } = ev;
        if (!messageId || !text) return;
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === messageId);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = {
              ...next[idx],
              content: (next[idx].content || "") + text,
              meta: { ...next[idx].meta, streaming: true },
            };
            return next;
          }
          // Assistant message placeholder created before first delta
          return [
            ...prev,
            {
              id: messageId,
              role: "assistant",
              content: text,
              meta: { streaming: true },
            },
          ];
        });
      } else if (ev.type === "avatar.state") {
        if (typeof ev.state === "string") {
          setAvatarState(ev.state);
        }
      }
    });

    return unsub;
  }, []);

  async function openConversation(conv: Conversation) {
    setActive(conv);
    try {
      const data = await apiJson<{ conversation: Conversation; messages: Message[] }>(
        `/api/conversations/${conv.id}`
      );
      setMessages(data.messages ?? []);
    } catch {
      setMessages([]);
    }
  }

  async function createNewChat() {
    setSelectorVisible(false);
    try {
      const conv = await apiJson<Conversation>("/api/conversations", {
        method: "POST",
        body: JSON.stringify({ title: "New chat" }),
      });
      setConversations((c) => [conv, ...c]);
      setActive(conv);
      setMessages([]);
    } catch {
      setActive(null);
      setMessages([]);
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");

    const clientMessageId = `m-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    // Optimistic user bubble
    const optimisticMsg: Message = {
      id: clientMessageId,
      role: "user",
      content: text,
      clientMessageId,
    };
    setMessages((prev) => [...prev, optimisticMsg]);

    // Ensure WS connection
    await connectWs();

    // Send chat.send frame to backend
    const sent = sendWs({
      type: "chat.send",
      conversationId: active?.id ?? null,
      text,
      clientMessageId,
    });

    if (!sent) {
      console.warn("[chat] failed to send over websocket");
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
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 88 : 0}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.headerTitleContainer}
          onPress={() => setSelectorVisible(true)}
          activeOpacity={0.7}
        >
          <Text style={styles.title} numberOfLines={1}>
            {active?.title || "New Chat"}
          </Text>
          <Ionicons name="chevron-down" size={16} color="#8d87a8" style={{ marginLeft: 4 }} />
        </TouchableOpacity>

        <View style={styles.headerRight}>
          {avatarState === "thinking" && (
            <View style={styles.stateIndicator}>
              <ActivityIndicator size="small" color="#8c7ae6" />
              <Text style={styles.stateText}>Thinking...</Text>
            </View>
          )}
          <TouchableOpacity style={styles.newChatBtn} onPress={createNewChat}>
            <Ionicons name="create-outline" size={20} color="#8c7ae6" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Messages List */}
      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.listContent}
        onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
        onLayout={() => flatListRef.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Ionicons name="chatbubbles-outline" size={48} color="#2b2740" />
            <Text style={styles.emptyTitle}>Hi Companion</Text>
            <Text style={styles.emptySub}>
              Ask questions, get assistance, or collaborate with your desktop agents.
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const isUser = item.role === "user";
          return (
            <View style={[styles.bubbleWrapper, isUser ? styles.userWrapper : styles.botWrapper]}>
              {!isUser && (
                <View style={styles.avatarIcon}>
                  <Text style={styles.avatarIconText}>Hi</Text>
                </View>
              )}
              <View style={[styles.bubble, isUser ? styles.userBubble : styles.botBubble]}>
                <Text style={styles.bubbleText}>{item.content || (item.meta?.streaming ? "..." : "")}</Text>
                {item.meta?.streaming && (
                  <View style={styles.streamingDot}>
                    <ActivityIndicator size="small" color="#8c7ae6" style={{ transform: [{ scale: 0.6 }] }} />
                  </View>
                )}
              </View>
            </View>
          );
        }}
      />

      {/* Composer */}
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message Hi..."
          placeholderTextColor="#787291"
          multiline
          maxLength={8000}
        />
        <TouchableOpacity
          style={[styles.sendBtn, !draft.trim() ? styles.sendBtnDisabled : null]}
          onPress={send}
          disabled={!draft.trim()}
        >
          <Ionicons name="arrow-up" size={18} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Conversation Selector Modal */}
      <Modal visible={selectorVisible} transparent animationType="fade">
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setSelectorVisible(false)}
        >
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Conversations</Text>
              <TouchableOpacity onPress={createNewChat}>
                <Text style={styles.newChatLink}>+ New Chat</Text>
              </TouchableOpacity>
            </View>
            <FlatList
              data={conversations}
              keyExtractor={(c) => c.id}
              style={{ maxHeight: 320 }}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[styles.convItem, item.id === active?.id ? styles.convItemActive : null]}
                  onPress={() => {
                    setSelectorVisible(false);
                    void openConversation(item);
                  }}
                >
                  <Ionicons
                    name="chatbubble-outline"
                    size={16}
                    color={item.id === active?.id ? "#8c7ae6" : "#787291"}
                    style={{ marginRight: 10 }}
                  />
                  <Text
                    style={[styles.convTitle, item.id === active?.id ? styles.convTitleActive : null]}
                    numberOfLines={1}
                  >
                    {item.title}
                  </Text>
                </TouchableOpacity>
              )}
            />
          </View>
        </TouchableOpacity>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#050508" },
  center: { flex: 1, backgroundColor: "#050508", alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255, 255, 255, 0.06)",
    backgroundColor: "#08070d",
  },
  headerTitleContainer: { flexDirection: "row", alignItems: "center", maxWidth: "65%" },
  title: { color: "#ece9ff", fontSize: 16, fontWeight: "700" },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  stateIndicator: { flexDirection: "row", alignItems: "center", gap: 4 },
  stateText: { color: "#8c7ae6", fontSize: 11, fontWeight: "600" },
  newChatBtn: {
    backgroundColor: "rgba(108, 92, 231, 0.15)",
    padding: 8,
    borderRadius: 8,
  },
  listContent: { padding: 16, paddingBottom: 24 },
  emptyContainer: { alignItems: "center", justifyContent: "center", paddingTop: 80, paddingHorizontal: 32 },
  emptyTitle: { color: "#ece9ff", fontSize: 18, fontWeight: "700", marginTop: 16, marginBottom: 8 },
  emptySub: { color: "#787291", fontSize: 13, textAlign: "center", lineHeight: 18 },
  bubbleWrapper: { flexDirection: "row", marginVertical: 4, alignItems: "flex-end" },
  userWrapper: { justifyContent: "flex-end" },
  botWrapper: { justifyContent: "flex-start" },
  avatarIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#6c5ce7",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 8,
    marginBottom: 4,
  },
  avatarIconText: { color: "#fff", fontSize: 11, fontWeight: "800" },
  bubble: { maxWidth: "80%", borderRadius: 16, paddingVertical: 10, paddingHorizontal: 14 },
  userBubble: { backgroundColor: "#6c5ce7", borderBottomRightRadius: 4 },
  botBubble: { backgroundColor: "#151320", borderBottomLeftRadius: 4, borderWidth: 1, borderColor: "rgba(255, 255, 255, 0.06)" },
  bubbleText: { color: "#ece9ff", fontSize: 14, lineHeight: 20 },
  streamingDot: { marginTop: 4, alignSelf: "flex-start" },
  composer: {
    flexDirection: "row",
    padding: 12,
    gap: 8,
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: "rgba(255, 255, 255, 0.06)",
    backgroundColor: "#08070d",
  },
  input: {
    flex: 1,
    backgroundColor: "#13111b",
    color: "#ece9ff",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 14,
    maxHeight: 100,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
  },
  sendBtn: {
    backgroundColor: "#6c5ce7",
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDisabled: { backgroundColor: "#221f2f", opacity: 0.6 },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  modalCard: {
    width: "100%",
    backgroundColor: "#121019",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255, 255, 255, 0.06)",
    marginBottom: 8,
  },
  modalTitle: { color: "#ece9ff", fontSize: 16, fontWeight: "700" },
  newChatLink: { color: "#8c7ae6", fontSize: 13, fontWeight: "600" },
  convItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  convItemActive: { backgroundColor: "rgba(108, 92, 231, 0.15)" },
  convTitle: { color: "#ece9ff", fontSize: 14, flex: 1 },
  convTitleActive: { color: "#8c7ae6", fontWeight: "600" },
});