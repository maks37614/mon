#!/usr/bin/env python3
"""Guest-only visual preview patch. ONLY for /home/ubuntu/h00k-old-stage/old-site."""
from pathlib import Path
import sys
root=Path(sys.argv[1]).resolve() if len(sys.argv)==2 else None
if root != Path('/home/ubuntu/h00k-old-stage/old-site'):
    raise SystemExit('Safety check: incorrect stage path')
server=(root/'server.ts').read_text(encoding='utf-8')
if 'Old preview: API disabled' not in server or 'Deliberately no CRON' not in server:
    raise SystemExit('Stage safety middleware/background task guards not found; aborting')

def patch(path, original, replacement):
    file=root/path
    s=file.read_text(encoding='utf-8')
    if replacement in s:
        print('Already patched: '+path)
        return
    if s.count(original)!=1:
        raise SystemExit('Refusing unexpected source in '+path)
    file.write_text(s.replace(original,replacement,1),encoding='utf-8')
    print('Patched: '+path)

patch('src/context/AuthContext.tsx',
'''  useEffect(() => {
    let unsubscribeProfile: (() => void) | null = null;
''',
'''  useEffect(() => {
    if (import.meta.env.VITE_OLD_STAGE_GUEST === '1') {
      // Local-only guest for historical UI; NOT a real Firebase/server identity.
      const uid = 'old_stage_browser_guest_v1';
      const guest = { uid, email: '', displayName: 'Гість', photoURL: '',
        isLocalUser: true, isStageGuest: true } as unknown as User;
      const now = new Date().toISOString();
      let localProfile: UserProfile = { uid, email: '', displayName: 'Гість',
        photoURL: '', soundAlertsEnabled: false,
        defaultExchange: 'binance', defaultMarketType: 'futures',
        defaultTimeframe: '15m', watchlist: [], watchlistFolders: {},
        metaScalpSettings: { ...DEFAULT_METASCALP_SETTINGS, enabled: false },
        createdAt: now, updatedAt: now };
      try {
        const raw = localStorage.getItem('signalhook_profile_' + uid);
        const saved = raw ? JSON.parse(raw) as UserProfile : null;
        if (saved?.uid === uid) localProfile = { ...localProfile, ...saved, uid, email: '' };
      } catch {}
      setUser(guest);
      setProfile(localProfile);
      setLoading(false);
      return;
    }
    let unsubscribeProfile: (() => void) | null = null;
''')
patch('src/context/AuthContext.tsx',
'  const logout = async () => {\n    try {',
'  const logout = async () => {\n    if ((user as any)?.isStageGuest) return;\n    try {')
patch('src/context/SurveillanceContext.tsx',
'    if (!user) { setCoins([]); setLoading(false); return; }',
'    if (!user || (user as any).isStageGuest) { setCoins([]); setLoading(false); return; }')
patch('src/context/SurveillanceContext.tsx',
'    fetchCoins();\n    const interval = setInterval(() => {\n      fetchCoins();',
'    fetchCoins();\n    if ((user as any)?.isStageGuest) return;\n    const interval = setInterval(() => {\n      fetchCoins();')
patch('src/context/AlertsContext.tsx',
'    if (isLocal) {\n      try {\n        const saved = localStorage.getItem(`signalhook_user_alerts_${user.uid}`);',
'''    if (isLocal) {
      if ((user as any).isStageGuest) {
        setAlerts([]); setHistory([]); setLoading(false);
        setLoadingHistory(false); return;
      }
      try {
        const saved = localStorage.getItem(`signalhook_user_alerts_${user.uid}`);''')
patch('src/context/AlertsContext.tsx',
'    if (!user?.uid) return;\n\n    let disposed = false;',
'    if (!user?.uid || (user as any)?.isStageGuest) return;\n\n    let disposed = false;')
patch('src/context/AlertsContext.tsx',
"      if (!user) {\n        throw new Error('Встановлення сповіщень доступне тільки для зареєстрованих користувачів. Будь ласка, увійдіть або зареєструйтесь.');\n      }",
"      if (!user || (user as any).isStageGuest) {\n        throw new Error('Сповіщення вимкнені у тестовій версії.');\n      }")
patch('src/context/TelegramContext.tsx',
'    if (!uid) {\n      setStatus(null);\n      setLinkUrl(null);\n      return null;\n    }',
'    if (!uid || (user as any)?.isStageGuest) {\n      setStatus(null);\n      setLinkUrl(null);\n      return null;\n    }')
patch('src/context/TelegramContext.tsx',
'    if (!uid) {\n      initializedAccount.current = null;',
'    if (!uid || (user as any)?.isStageGuest) {\n      initializedAccount.current = null;')
patch('src/context/TelegramContext.tsx',
'    if (!user?.uid || !status?.linkPending) return;',
'    if (!user?.uid || (user as any)?.isStageGuest || !status?.linkPending) return;')
patch('Dockerfile.stage',
'RUN npm run build && npm prune --omit=dev',
'ENV VITE_OLD_STAGE_GUEST=1\nRUN npm run build && npm prune --omit=dev')
print('Stage guest enabled. Production, Caddy and backend safety rules unchanged.')
