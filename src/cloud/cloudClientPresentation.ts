import type { UiLanguage } from '../uiLanguage.js'

export function missingDurableDriveAuthorizationMessage(lang: UiLanguage) {
  return lang === 'zh'
    ? 'Google 没有返回持续授权。请重新登录并在 Google 授权页确认允许 Drive appData 访问。'
    : 'Google did not return durable authorization. Sign in again and confirm Drive appData access on the Google consent screen.'
}

export function signedOutCloudAccountMessage(lang: UiLanguage) {
  return lang === 'zh'
    ? 'PJSDAS 账号未登录。请先使用 Google 登录 PJSDAS。'
    : 'Your PJSDAS account is not signed in. Sign in to PJSDAS with Google first.'
}

export function driveAccessTokenRecoveryMessage(lang: UiLanguage, status: number) {
  return lang === 'zh'
    ? `无法恢复 Google Drive 授权（HTTP ${status}）。`
    : `Could not restore Google Drive authorization (HTTP ${status}).`
}
