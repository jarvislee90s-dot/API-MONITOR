import { type FormEvent, useState } from "react";

interface LoginPageProps {
  loading: boolean;
  error: string | null;
  onSignIn: (email: string, password: string) => Promise<void>;
}

export function LoginPage({ loading, error, onSignIn }: LoginPageProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSignIn(email.trim(), password);
  }

  return (
    <main className="app-shell auth-shell">
      <section className="auth-card">
        <p className="kicker">ApiMonitor</p>
        <h1>登录后访问用量看板</h1>
        <p className="auth-card__summary">
          使用 Supabase 账号登录后，才能查看看板和维护供应商账号配置。
        </p>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label>
            <span>邮箱</span>
            <input
              type="email"
              value={email}
              autoComplete="email"
              required
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            <span>密码</span>
            <input
              type="password"
              value={password}
              autoComplete="current-password"
              required
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error ? <div className="auth-error">{error}</div> : null}
          <button className="btn btn--primary" type="submit" disabled={loading}>
            {loading ? "登录中..." : "登录"}
          </button>
        </form>
      </section>
    </main>
  );
}
