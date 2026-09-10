import { chatgptCompatHandler } from '../gateway/chatgptCompat'

export default {
  fetch(request: Request) {
    return chatgptCompatHandler.fetch(request)
  },
}
