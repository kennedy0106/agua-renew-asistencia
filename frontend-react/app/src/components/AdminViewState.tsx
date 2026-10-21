// Estado de vista de la sesión administrativa.
//
// Guarda SOLO contexto explícito de interfaz (búsquedas, filtros, selección de
// periodo, borradores de cargos) en memoria volátil de React. No usa
// localStorage/sessionStorage ni la URL, no contiene listados de la API ni
// credenciales, y desaparece al desmontar el provider (salir del área privada,
// cerrar sesión o cambiar de usuario).
//
/* eslint-disable react-refresh/only-export-components -- el contrato del módulo expone provider y hook juntos */
// El shell monta un único provider con `key={user.id}`; cada página consume
// claves estables por módulo y campo. Cuando no hay provider (pruebas aisladas
// o montajes standalone) el hook se comporta como un `useState` normal.

import {
  createContext,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

type Listener = () => void;

function resolveInitial<T>(initial: T | (() => T)): T {
  return typeof initial === "function" ? (initial as () => T)() : initial;
}

/**
 * Almacén por claves con suscripciones aisladas: actualizar una clave solo
 * notifica a los hooks suscritos a esa clave, nunca a todo el árbol.
 */
class AdminViewStateStore {
  private readonly values = new Map<string, unknown>();
  private readonly listeners = new Map<string, Set<Listener>>();

  has(key: string): boolean {
    return this.values.has(key);
  }

  read<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  ensure<T>(key: string, initial: T | (() => T)): T {
    if (!this.values.has(key)) {
      this.values.set(key, resolveInitial(initial));
    }
    return this.values.get(key) as T;
  }

  set<T>(key: string, action: SetStateAction<T>): void {
    const current = this.values.get(key) as T;
    const next =
      typeof action === "function" ? (action as (previous: T) => T)(current) : action;
    if (Object.is(next, current)) return;
    this.values.set(key, next);
    const listeners = this.listeners.get(key);
    if (!listeners) return;
    // Se copia para tolerar bajas durante la notificación.
    for (const listener of Array.from(listeners)) listener();
  }

  subscribe(key: string, listener: Listener): () => void {
    let listeners = this.listeners.get(key);
    if (!listeners) {
      listeners = new Set<Listener>();
      this.listeners.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.listeners.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(key);
    };
  }
}

const AdminViewStateContext = createContext<AdminViewStateStore | null>(null);

/**
 * Provider de memoria de sesión. Debe montarse una sola vez dentro del área
 * privada y remontarse con `key={user.id}` al cambiar de usuario.
 */
export function AdminViewStateProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new AdminViewStateStore());
  return (
    <AdminViewStateContext.Provider value={store}>{children}</AdminViewStateContext.Provider>
  );
}

/**
 * Lee y actualiza un valor de vista estable.
 *
 * - `key`: identificador estable de módulo/campo (por ejemplo
 *   `"employees.search"`). No debe incluir datos personales.
 * - `initialValueOrInitializer`: mismo contrato que `useState`; si es función
 *   se evalúa de forma perezosa y una sola vez por montaje.
 *
 * El setter acepta valores o actualizaciones funcionales, igual que `useState`.
 */
export function useAdminViewState<T>(
  key: string,
  initialValueOrInitializer: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const store = useContext(AdminViewStateContext);

  // La inicialización ocurre en el inicializador perezoso de useState para no
  // repetirla en cada render ni forzar trabajo durante la fase de pintado.
  const [localValue, setLocalValue] = useState<T>(() => {
    if (store) return store.ensure(key, initialValueOrInitializer);
    return resolveInitial(initialValueOrInitializer);
  });

  const subscribe = useCallback(
    (listener: Listener) => (store ? store.subscribe(key, listener) : () => undefined),
    [store, key],
  );

  const getSnapshot = useCallback(
    () => (store ? (store.read<T>(key) as T) : localValue),
    [store, key, localValue],
  );

  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const setValue = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      if (store) {
        store.set(key, action);
      } else {
        setLocalValue(action);
      }
    },
    [store, key],
  );

  return [value, setValue];
}
