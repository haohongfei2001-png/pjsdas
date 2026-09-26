export type CloudUiLanguage = 'zh' | 'en'

export function currentCloudUiLanguage(): CloudUiLanguage {
  if (typeof window === 'undefined') return 'zh'
  return window.localStorage.getItem('pjsdas-ui-language') === 'en' ? 'en' : 'zh'
}

export function missingDurableDriveAuthorizationMessage(lang: CloudUiLanguage) {
  return lang === 'zh'
    ? 'Google 没有返回持续授权。请重新登录并在 Google 授权页确认允许 Drive appData 访问。'
    : 'Google did not return durable authorization. Sign in again and confirm Drive appData access on the Google consent screen.'
}

export function signedOutCloudAccountMessage(lang: CloudUiLanguage) {
  return lang === 'zh'
    ? 'TodayAction 账号未登录。请先使用 Google 登录 TodayAction。'
    : 'Your TodayAction account is not signed in. Sign in to TodayAction with Google first.'
}

export function driveAccessTokenRecoveryMessage(lang: CloudUiLanguage, status: number) {
  return lang === 'zh'
    ? `无法恢复 Google Drive 授权（HTTP ${status}）。`
    : `Could not restore Google Drive authorization (HTTP ${status}).`
}
