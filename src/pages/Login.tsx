import { useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { KeyRound, Shield, Loader2 } from "lucide-react";
import { ScalePadLogo } from "@/components/branding/ScalePadLogo";

export default function Login() {
  const [tab, setTab] = useState<"user" | "admin">("user");
  const [apiKey, setApiKey] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [loading, setLoading] = useState(false);
  const { loginAsUser, loginAsAdmin, signUpAdmin } = useAuth();
  const navigate = useNavigate();

  const handleUserLogin = () => {
    if (loginAsUser(apiKey)) {
      navigate("/marketplace");
    } else {
      toast.error("Please enter a valid API key");
    }
  };

  const handleAdminAuth = async () => {
    if (!email.trim() || !password.trim()) {
      toast.error("Email and password are required");
      return;
    }
    setLoading(true);
    try {
      if (isSignUp) {
        const result = await signUpAdmin(email, password);
        if (result.success) {
          toast.success("Admin account created");
          navigate("/marketplace");
        } else {
          toast.error(result.error || "Signup failed");
        }
      } else {
        const result = await loginAsAdmin(email, password);
        if (result.success) {
          navigate("/marketplace");
        } else {
          toast.error(result.error || "Login failed");
        }
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md animate-fade-in">
        {/* Branding */}
        <div className="text-center mb-8">
          <div className="flex justify-center"><ScalePadLogo /></div>
        </div>

        {/* Card */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          {/* Tabs */}
          <div className="flex border-b border-border">
            <button
              onClick={() => setTab("user")}
              className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors duration-150 ${
                tab === "user"
                  ? "text-primary border-b-2 border-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <KeyRound className="w-4 h-4" />
              User Login
            </button>
            <button
              onClick={() => setTab("admin")}
              className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors duration-150 ${
                tab === "admin"
                  ? "text-primary border-b-2 border-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Shield className="w-4 h-4" />
              Admin Login
            </button>
          </div>

          {/* Form */}
          <div className="p-6">
            {tab === "user" ? (
              <div className="space-y-4">
                <div>
                  <label className="text-xs text-muted-foreground mb-1.5 block">ScalePad API Key</label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleUserLogin()}
                    placeholder="Enter your API key"
                    className="w-full h-10 px-3 bg-surface-raised border border-border rounded-md text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <p className="text-[11px] text-muted-foreground mt-1.5">
                    Your key is stored in session only and never sent to our servers.
                  </p>
                </div>
                <button
                  onClick={handleUserLogin}
                  className="w-full h-10 bg-primary hover:bg-primary/90 text-primary-foreground font-medium rounded-md text-sm transition-colors duration-150"
                >
                  Connect
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="text-xs text-muted-foreground mb-1.5 block">Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="admin@example.com"
                    className="w-full h-10 px-3 bg-surface-raised border border-border rounded-md text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1.5 block">Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleAdminAuth()}
                    placeholder="Enter password"
                    className="w-full h-10 px-3 bg-surface-raised border border-border rounded-md text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <button
                  onClick={handleAdminAuth}
                  disabled={loading}
                  className="w-full h-10 bg-primary hover:bg-primary/90 disabled:opacity-50 text-primary-foreground font-medium rounded-md text-sm transition-colors duration-150 flex items-center justify-center gap-2"
                >
                  {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                  {isSignUp ? "Create Admin Account" : "Login"}
                </button>
                <button
                  onClick={() => setIsSignUp(!isSignUp)}
                  className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {isSignUp ? "Already have an account? Login" : "First time? Create admin account"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
