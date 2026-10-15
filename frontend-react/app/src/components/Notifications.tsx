import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { X } from "./Icons";

type NoticeTone = "success" | "error";
// "enter" is painted before "open" so the entry transition has a start value;
// "exit" keeps the node mounted until the leave transition finishes.
type NoticeState = "enter" | "open" | "exit";
type Notice = { id: number; message: string; tone: NoticeTone; state: NoticeState };
const NoticeContext = createContext<{ success: (message: string) => void; error: (message: string) => void } | null>(null);

const AUTO_DISMISS_MS = 5000;
const EXIT_MS = 220;
const MAX_NOTICES = 3;

export function Notifications({ children }: { children: React.ReactNode }) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const nextIdRef = useRef(0);
  const timersRef = useRef(new Map<number, number>());

  const remove = useCallback((id: number) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  const dismiss = useCallback((id: number) => {
    const pending = timersRef.current.get(id);
    if (pending) {
      window.clearTimeout(pending);
      timersRef.current.delete(id);
    }
    setNotices((current) => current.map((notice) => (notice.id === id && notice.state !== "exit" ? { ...notice, state: "exit" } : notice)));
    const exitTimer = window.setTimeout(() => {
      timersRef.current.delete(id);
      remove(id);
    }, EXIT_MS);
    timersRef.current.set(id, exitTimer);
  }, [remove]);

  const add = useCallback((message: string, tone: NoticeTone) => {
    nextIdRef.current += 1;
    const id = nextIdRef.current;
    setNotices((current) => [...current, { id, message, tone, state: "enter" }]);
    const autoTimer = window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    timersRef.current.set(id, autoTimer);
  }, [dismiss]);

  // Paint "enter" first, then transition to "open" on the next frame.
  useEffect(() => {
    if (!notices.some((notice) => notice.state === "enter")) return;
    const frame = window.requestAnimationFrame(() => {
      setNotices((current) => current.map((notice) => (notice.state === "enter" ? { ...notice, state: "open" } : notice)));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [notices]);

  // Bound the host without popping nodes: retire the oldest with its exit; it
  // stays mounted until the leave transition ends.
  useEffect(() => {
    const active = notices.filter((notice) => notice.state !== "exit");
    if (active.length <= MAX_NOTICES) return;
    active.slice(0, active.length - MAX_NOTICES).forEach((notice) => dismiss(notice.id));
  }, [notices, dismiss]);

  useEffect(() => () => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current.clear();
  }, []);

  return <NoticeContext.Provider value={{ success: (message) => add(message, "success"), error: (message) => add(message, "error") }}>
    {children}
    <div className="notification-host" aria-live="polite" aria-relevant="additions" role="status">
      {notices.map((notice) => (
        <div key={notice.id} data-state={notice.state} className={`notification notification--${notice.tone}`}>
          <span className="notification-message">{notice.message}</span>
          <button type="button" className="notification-close" onClick={() => dismiss(notice.id)} aria-label="Cerrar notificación">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  </NoticeContext.Provider>;
}

export function useNotifications() {
  const context = useContext(NoticeContext);
  if (!context) throw new Error("useNotifications debe usarse dentro de Notifications");
  return context;
}
