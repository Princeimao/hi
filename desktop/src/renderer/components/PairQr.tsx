import React, { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { RestAuth } from "../api";

export function PairQr(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [payload, setPayload] = useState<string>("");

  useEffect(() => {
    void (async () => {
      const auth: RestAuth = await window.hi.restAuth();
      const ip = await window.hi.lanIp();
      let base = auth.restBase;
      try {
        const u = new URL(base);
        if (u.hostname === "localhost" || u.hostname === "127.0.0.1") u.hostname = ip;
        base = u.toString().replace(/\/$/, "");
      } catch {
        // keep original
      }
      const data = JSON.stringify({ apiUrl: base, accessToken: auth.token, refreshToken: auth.token });
      setPayload(data);
      if (canvasRef.current) {
        void QRCode.toCanvas(canvasRef.current, data, { width: 220, margin: 1 });
      }
    })();
  }, []);

  useEffect(() => {
    if (payload && canvasRef.current) {
      void QRCode.toCanvas(canvasRef.current, payload, { width: 220, margin: 1 });
    }
  }, [payload]);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      <canvas ref={canvasRef} />
      <div style={{ fontSize: 10, color: "#8d87a8", maxWidth: 260, wordBreak: "break-all" }}>{payload}</div>
    </div>
  );
}