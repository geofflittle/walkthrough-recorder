const screen = (testId, inner) =>
  `<div class="screen" data-testid="${testId}">${inner}</div>`;

const wire = () => {
  const cart = document.querySelector('[data-testid=shop-cart-primary]');
  if (cart) cart.onclick = showPayment;

  const gift = document.querySelector('[data-testid=shop-gift-toggle]');
  if (gift)
    gift.onclick = () => {
      const on = gift.getAttribute('aria-pressed') === 'true';
      gift.setAttribute('aria-pressed', String(!on));
      gift.textContent = on ? 'Add gift wrap' : 'Gift wrap added';
      const note = document.querySelector('[data-testid=shop-gift-note]');
      note.textContent = on ? '' : 'Gift wrap adds 2.00 to your total.';
    };

  const pay = document.querySelector('[data-testid=shop-pay-primary]');
  if (pay)
    pay.onclick = () => {
      document.body.innerHTML = screen(
        'shop-checkout-ok',
        '<h2>Order complete</h2><p>Thanks. A receipt is on its way.</p>',
      );
    };
};

function showPayment() {
  document.body.innerHTML = screen(
    'shop-pay-step',
    '<h2>Payment</h2>' +
      '<input data-testid="shop-code-value" placeholder="Discount code">' +
      '<button data-testid="shop-gift-toggle" aria-pressed="false">Add gift wrap</button>' +
      '<p data-testid="shop-gift-note"></p>' +
      '<button data-testid="shop-pay-primary">Pay now</button>' +
      '<p>Your order number is <b data-testid="shop-order-1">TS-4417</b></p>',
  );
  wire();
}

wire();
