// Paste into the browser devtools console while logged in to the shop (http://127.0.0.1:3100) as a @demo.local user.
// Storage keys (frontend/src/app/login/login.component.ts:150,154 and Services/request.interceptor.ts:16):
//   localStorage 'token'  -> JWT sent as "Authorization: Bearer <token>"
//   sessionStorage 'bid'  -> basket id
(async () => {
  const N = 30, PRODUCT = 2, DELAY_MS = 300
  const token = localStorage.getItem('token')
  const bid = sessionStorage.getItem('bid')
  if (!token || !bid) { console.error('Not logged in (no token/bid). Log in as shopperNN@demo.local first.'); return }
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
  for (let i = 1; i <= N; i++) {
    const add = await fetch('/api/BasketItems', { method: 'POST', headers, body: JSON.stringify({ BasketId: bid, ProductId: PRODUCT, quantity: 1 }) })
    const res = await fetch(`/rest/basket/${bid}/checkout`, { method: 'POST', headers, body: JSON.stringify({ orderDetails: { deliveryMethodId: '999' } }) })
    console.log(`#${i} add=${add.status} checkout=${res.status} X-Checkout-Version=${res.headers.get('X-Checkout-Version')}`)
    await new Promise((r) => setTimeout(r, DELAY_MS))
  }
})()
