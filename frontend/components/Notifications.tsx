"use client";

import { createContext, useCallback, useContext, useState } from "react";

type Notice = { id: number; message: string; tone: "success" | "error" };
const NoticeContext = createContext<{ success: (message: string) => void; error: (message: string) => void } | null>(null);

export function Notifications({ children }: { children: React.ReactNode }) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const add = useCallback((message: string, tone: Notice["tone"]) => {
    const id = Date.now() + Math.random();
    setNotices((current) => [...current, { id, message, tone }].slice(-3));
    window.setTimeout(() => setNotices((current) => current.filter((notice) => notice.id !== id)), 5000);
  }, []);
  return <NoticeContext.Provider value={{ success: (message) => add(message, "success"), error: (message) => add(message, "error") }}>
    {children}
    <div className="notification-host" aria-live="polite" aria-relevant="additions" role="status">
      {notices.map((notice) => <div key={notice.id} className={`notification notification--${notice.tone}`}>{notice.message}</div>)}
    </div>
  </NoticeContext.Provider>;
}

export function useNotifications() {
  const context = useContext(NoticeContext);
  if (!context) throw new Error("useNotifications debe usarse dentro de Notifications");
  return context;
}
