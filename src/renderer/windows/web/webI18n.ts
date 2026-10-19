import i18n from 'i18next'
import resourcesToBackend from 'i18next-resources-to-backend'
import { initReactI18next } from 'react-i18next'

const locales = {
  'de-DE': () => import('../../i18n/locales/de-de.json'),
  'el-GR': () => import('../../i18n/locales/el-gr.json'),
  'en-US': () => import('../../i18n/locales/en-us.json'),
  'es-ES': () => import('../../i18n/locales/es-es.json'),
  'fr-FR': () => import('../../i18n/locales/fr-fr.json'),
  'ja-JP': () => import('../../i18n/locales/ja-jp.json'),
  'pt-PT': () => import('../../i18n/locales/pt-pt.json'),
  'ro-RO': () => import('../../i18n/locales/ro-ro.json'),
  'ru-RU': () => import('../../i18n/locales/ru-ru.json'),
  'tr-TR': () => import('../../i18n/locales/tr-tr.json'),
  'vi-VN': () => import('../../i18n/locales/vi-vn.json'),
  'zh-CN': () => import('../../i18n/locales/zh-cn.json'),
  'zh-TW': () => import('../../i18n/locales/zh-tw.json')
}

const language =
  Object.keys(locales).find((locale) => locale.toLowerCase() === navigator.language.toLowerCase()) || 'en-US'

export const ready = i18n
  .use(resourcesToBackend((locale: string) => locales[locale as keyof typeof locales]?.()))
  .use(initReactI18next)
  .init({
    lng: language,
    fallbackLng: 'en-US',
    load: 'currentOnly',
    keySeparator: false,
    interpolation: { escapeValue: false }
  })
