import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { View, ActivityIndicator } from "react-native";
import { getAccessToken } from "../src/lib/api";

export default function Index() {
  const [token, setToken] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    getAccessToken().then(setToken);
  }, []);

  if (token === undefined) {
    return (
      <View style={{ flex: 1, backgroundColor: "#050508", alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color="#6c5ce7" size="large" />
      </View>
    );
  }

  if (token) return <Redirect href="/(tabs)/home" />;
  return <Redirect href="/(tabs)/pair" />;
}