import React, { createContext, useContext, useState, useCallback, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";

type Role = "user" | "admin";

interface AuthState {
  apiKey: string;
  role: Role;
  isAuthenticated: boolean;
  adminEmail: string | null;
  loginAsUser: (apiKey: string) => boolean;
  loginAsAdmin: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  /** SHA-256 hash of the API key for identifying users without storing raw key */
  userHash: string;
  /** Track recently launched app IDs (max 3) */
  recentApps: string[];
  addRecentApp: (id: string) => void;
}

const AuthContext = createContext<AuthState | null>(null);

async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem("sp_api_key") || "");
  const [userHash, setUserHash] = useState(() => sessionStorage.getItem("sp_user_hash") || "");
  const [role, setRole] = useState<Role>(() => (sessionStorage.getItem("sp_role") as Role) || "user");
  const [isAuthenticated, setIsAuthenticated] = useState(() => sessionStorage.getItem("sp_auth") === "1");
  const [adminEmail, setAdminEmail] = useState<string | null>(() => sessionStorage.getItem("sp_admin_email"));
  const [recentApps, setRecentApps] = useState<string[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem("sp_recent") || "[]");
    } catch {
      return [];
    }
  });

  // Check for existing Supabase session on mount
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (session?.user && sessionStorage.getItem("sp_role") === "admin") {
        setAdminEmail(session.user.email || null);
        sessionStorage.setItem("sp_admin_email", session.user.email || "");
      }
    });

    // Check existing session
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user && sessionStorage.getItem("sp_role") === "admin") {
        setAdminEmail(session.user.email || null);
        setRole("admin");
        setIsAuthenticated(true);
        setApiKey("admin-key");
        sessionStorage.setItem("sp_admin_email", session.user.email || "");
        sessionStorage.setItem("sp_auth", "1");
        sessionStorage.setItem("sp_role", "admin");
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // Persist recent apps
  useEffect(() => {
    sessionStorage.setItem("sp_recent", JSON.stringify(recentApps));
  }, [recentApps]);

  const loginAsUser = useCallback((key: string) => {
    if (!key.trim()) return false;
    setApiKey(key);
    setRole("user");
    setIsAuthenticated(true);
    setAdminEmail(null);
    sessionStorage.setItem("sp_api_key", key);
    sessionStorage.setItem("sp_role", "user");
    sessionStorage.setItem("sp_auth", "1");
    sessionStorage.removeItem("sp_admin_email");

    // Compute hash async
    hashApiKey(key).then((hash) => {
      setUserHash(hash);
      sessionStorage.setItem("sp_user_hash", hash);
    });

    return true;
  }, []);

  const loginAsAdmin = useCallback(async (email: string, password: string): Promise<{ success: boolean; error?: string }> => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { success: false, error: error.message };
    if (!data.user) return { success: false, error: "Login failed" };

    setApiKey("admin-key");
    setRole("admin");
    setIsAuthenticated(true);
    setAdminEmail(data.user.email || null);
    sessionStorage.setItem("sp_api_key", "admin-key");
    sessionStorage.setItem("sp_role", "admin");
    sessionStorage.setItem("sp_auth", "1");
    sessionStorage.setItem("sp_admin_email", data.user.email || "");
    return { success: true };
  }, []);

  const logout = useCallback(async () => {
    if (role === "admin") {
      await supabase.auth.signOut();
    }
    setApiKey("");
    setRole("user");
    setIsAuthenticated(false);
    setAdminEmail(null);
    setUserHash("");
    sessionStorage.removeItem("sp_api_key");
    sessionStorage.removeItem("sp_role");
    sessionStorage.removeItem("sp_auth");
    sessionStorage.removeItem("sp_admin_email");
    sessionStorage.removeItem("sp_user_hash");
  }, [role]);

  const addRecentApp = useCallback((id: string) => {
    setRecentApps((prev) => {
      const next = [id, ...prev.filter((i) => i !== id)].slice(0, 3);
      return next;
    });
  }, []);

  return (
    <AuthContext.Provider
      value={{ apiKey, role, isAuthenticated, adminEmail, loginAsUser, loginAsAdmin, logout, userHash, recentApps, addRecentApp }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
