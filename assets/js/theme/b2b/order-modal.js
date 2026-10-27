/**
 * B2B Order Modal
 *
 * Opens the shared #previewModal with a clean variant × QTY table.
 *
 * Variant data is fetched via the BigCommerce GraphQL Storefront API (/graphql)
 * using the storefront token injected from settings.storefront_api.token.
 *
 * Displays:
 *   - 'inc GST' (data-product-price-with-tax)
 *   - 'ex GST'  (data-product-price-with-tax / 11 * 10 rounded to 2 decimal places)
 *   - 'MSRP'    (data-product-non-sale-price-with-tax)
 *   - 'Stock'   ('In stock', 'Low stock', 'Out of Stock')
 *   - 'Qty'     (guarded to not exceed available inventory)
 *
 * Cart additions use the Storefront Cart REST API (/api/storefront/carts).
 */
import { defaultModal } from '../global/modal';

const VARIANTS_QUERY = `
    query GetProductVariants($productId: Int!) {
        site {
            product(entityId: $productId) {
                name
                prices {
                    price       { value currencyCode }
                    salePrice   { value currencyCode }
                    basePrice   { value currencyCode }
                    retailPrice { value currencyCode }
                }
                inventory {
                    isInStock
                    isStockTracked
                    hasVariantInventory
                    aggregated {
                        availableToSell
                        warningLevel
                    }
                }
                variants(first: 250) {
                    edges {
                        node {
                            entityId
                            sku
                            isPurchasable
                            prices {
                                price       { value currencyCode }
                                salePrice   { value currencyCode }
                                basePrice   { value currencyCode }
                                retailPrice { value currencyCode }
                            }
                            inventory {
                                isInStock
                                aggregated {
                                    availableToSell
                                    warningLevel
                                }
                            }
                            options {
                                edges {
                                    node {
                                        displayName
                                        values {
                                            edges {
                                                node {
                                                    label
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
`;

export default class OrderModal {
    constructor(context) {
        this.context = context;
        this.modal = defaultModal();
        this.token = context?.storefrontApiToken || '';
    }

    /**
     * Resolve storefront token with fallbacks
     */
    getToken() {
        if (this.token) return this.token;
        const inputToken = document.getElementById('storefront_api_token')?.value;
        if (inputToken) return inputToken;
        if (this.context?.storefrontApiToken) return this.context.storefrontApiToken;
        if (window.jsContext?.storefrontApiToken) return window.jsContext.storefrontApiToken;
        return '';
    }

    /**
     * Wire all [data-b2b-order-btn] clicks via event delegation.
     */
    init($scope = $('body')) {
        $scope.on('click', '[data-b2b-order-btn]', (e) => {
            e.preventDefault();
            const $btn = $(e.currentTarget);
            const $item = $btn.closest('.listItem');
            const productId = parseInt($btn.data('productId'), 10);
            const productName = String($btn.data('productName') || '');

            // 1. Get inc GST price from button data-attribute or DOM span
            let priceWithTax = $btn.data('productPriceWithTax')
                || $btn.attr('data-product-price-with-tax')
                || $item.data('productPriceWithTax')
                || $item.attr('data-product-price-with-tax');
            if (priceWithTax === undefined || priceWithTax === '') {
                const domWithTax = $item.find('[data-product-price-with-tax]').first().text().trim()
                    || $item.find('[data-product-price-without-tax]').first().text().trim();
                if (domWithTax) priceWithTax = domWithTax;
            }

            // 2. Get MSRP (Sale Price, or Default Price if no Sale Price is set)
            let msrp = $btn.data('productMsrp')
                || $btn.attr('data-product-msrp')
                || $item.data('productMsrp')
                || $item.attr('data-product-msrp');
            if (msrp === undefined || msrp === '') {
                const domMsrp = $item.find('[data-product-msrp-value]').first().text().trim()
                    || $item.find('[data-product-msrp-without-tax-value]').first().text().trim()
                    || $item.find('[data-product-non-sale-price-with-tax]').first().text().trim()
                    || $item.find('[data-product-non-sale-price-without-tax]').first().text().trim()
                    || $item.find('[data-product-rrp-with-tax]').first().text().trim()
                    || $item.find('[data-product-rrp-price-without-tax]').first().text().trim();
                if (domMsrp) msrp = domMsrp;
            }

            // 3. Fallback non-sale price if MSRP still not determined
            let nonSalePriceWithTax = $btn.data('productSalePriceWithTax') || $btn.attr('data-product-sale-price-with-tax');
            if (nonSalePriceWithTax === undefined || nonSalePriceWithTax === '') {
                const domNonSale = $item.find('[data-product-non-sale-price-with-tax]').first().text().trim()
                    || $item.find('[data-product-non-sale-price-without-tax]').first().text().trim();
                if (domNonSale) nonSalePriceWithTax = domNonSale;
            }

            this._open(productId, productName, { priceWithTax, msrp, nonSalePriceWithTax });
        });
    }

    // -------------------------------------------------------------------------
    // Private — open flow
    // -------------------------------------------------------------------------

    async _open(productId, productName, priceInfo = {}) {
        this.modal.open({ size: 'large' });
        this.modal.updateContent(this._loadingHtml(productName));

        const token = this.getToken();
        if (!token) {
            // eslint-disable-next-line no-console
            console.error('[B2B OrderModal] No storefront API token found.');
            this.modal.updateContent(this._errorHtml('Storefront API token missing. Contact your developer.'));
            return;
        }

        try {
            const gqlProduct = await this._fetchVariants(productId, token);
            const product = this._normalise(productId, gqlProduct, priceInfo);
            this.modal.updateContent(this._buildModalHtml(product));
            this._bindQtyGuards();
            this._bindFormSubmit(product.id);
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[B2B OrderModal] GraphQL fetch error:', err);
            this.modal.updateContent(this._errorHtml());
        }
    }

    // -------------------------------------------------------------------------
    // Private — GraphQL fetch
    // -------------------------------------------------------------------------

    async _fetchVariants(productId, token) {
        const res = await fetch('/graphql', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
                query: VARIANTS_QUERY,
                variables: { productId },
            }),
        });

        if (!res.ok) {
            throw new Error(`GraphQL HTTP ${res.status}`);
        }

        const json = await res.json();

        if (json.errors && json.errors.length) {
            throw new Error(json.errors.map(e => e.message).join('; '));
        }

        const product = json.data?.site?.product;
        if (!product) throw new Error('Product not found in GraphQL response');
        return product;
    }

    // -------------------------------------------------------------------------
    // Private — Price helpers
    // -------------------------------------------------------------------------

    _parsePrice(val) {
        if (typeof val === 'number') return isNaN(val) ? null : val;
        if (!val) return null;
        const cleaned = String(val).replace(/[^0-9.]/g, '');
        const num = parseFloat(cleaned);
        return isNaN(num) ? null : num;
    }

    _formatCurrency(num) {
        if (num === null || num === undefined || isNaN(num)) return '—';
        return `$${Number(num).toFixed(2)}`;
    }

    /**
     * Compute inventory status label, badge class, and maximum purchasable quantity.
     * Returns: { status: 'In stock' | 'Low stock' | 'Out of Stock', statusClass: 'in' | 'low' | 'out', availableQty: number }
     */
    _getInventoryInfo(productInventory, variantInventory, isPurchasable) {
        if (!isPurchasable) {
            return { status: 'Out of Stock', statusClass: 'out', availableQty: 0 };
        }

        const isStockTracked = productInventory?.isStockTracked !== false;
        if (!isStockTracked) {
            return { status: 'In stock', statusClass: 'in', availableQty: 9999 };
        }

        const inv = variantInventory || productInventory;
        const isInStock = inv?.isInStock !== false;
        const availableToSell = inv?.aggregated?.availableToSell !== undefined && inv?.aggregated?.availableToSell !== null
            ? Math.max(0, Number(inv.aggregated.availableToSell))
            : 0;
        const warningLevel = Number(inv?.aggregated?.warningLevel || 0);

        if (!isInStock || availableToSell <= 0) {
            return { status: 'Out of Stock', statusClass: 'out', availableQty: 0 };
        }

        const isLow = (warningLevel > 0 && availableToSell <= warningLevel)
            || (warningLevel <= 0 && availableToSell <= 5);

        if (isLow) {
            return { status: 'Low stock', statusClass: 'low', availableQty: availableToSell };
        }

        return { status: 'In stock', statusClass: 'in', availableQty: availableToSell };
    }

    /**
     * Map raw GraphQL product shape to internal view model
     */
    _normalise(productId, gqlProduct, priceInfo = {}) {
        const baseIncGst = this._parsePrice(priceInfo.priceWithTax)
            ?? this._parsePrice(
                gqlProduct.prices?.salePrice?.value
                ?? gqlProduct.prices?.price?.value,
            );

        const baseMsrp = this._parsePrice(priceInfo.msrp)
            ?? this._parsePrice(priceInfo.nonSalePriceWithTax)
            ?? (this._parsePrice(gqlProduct.prices?.salePrice?.value) !== null
                ? Math.round(this._parsePrice(gqlProduct.prices?.salePrice?.value) * 1.1 * 100) / 100
                : null)
            ?? (this._parsePrice(gqlProduct.prices?.basePrice?.value) !== null
                ? Math.round(this._parsePrice(gqlProduct.prices?.basePrice?.value) * 1.1 * 100) / 100
                : null);

        const variants = (gqlProduct.variants?.edges ?? []).map(({ node }) => {
            const label = (node.options?.edges ?? [])
                .map(({ node: opt }) => {
                    const vals = opt.values?.edges ?? [];
                    return vals.map(({ node: v }) => v.label).join('');
                })
                .filter(Boolean)
                .join(' / ') || 'Default';

            // Check if this variant has a relative price difference in GraphQL
            const gqlBasePrice = this._parsePrice(gqlProduct.prices?.price?.value);
            const gqlVariantPrice = this._parsePrice(node.prices?.price?.value);

            let incGst = baseIncGst;
            if (baseIncGst !== null && gqlBasePrice && gqlVariantPrice && gqlVariantPrice !== gqlBasePrice) {
                // Scale variant price proportionally with customer group discount
                incGst = Math.round((baseIncGst * (gqlVariantPrice / gqlBasePrice)) * 100) / 100;
            }

            // 2. ex GST: inc GST / 11 * 10 rounded to 2 decimal places
            const exGst = incGst !== null
                ? Math.round((incGst / 11 * 10) * 100) / 100
                : null;

            // 3. MSRP: with-tax retail price (matches card/PDP Was price)
            let msrp = baseMsrp;
            if (baseMsrp !== null && gqlBasePrice && gqlVariantPrice && gqlVariantPrice !== gqlBasePrice) {
                // Scale variant MSRP proportionally if variant has different price
                msrp = Math.round((baseMsrp * (gqlVariantPrice / gqlBasePrice)) * 100) / 100;
            } else if (msrp === null || msrp === undefined) {
                // Fallback from variant GraphQL prices (with 10% GST added since GraphQL is ex-tax)
                const gSale = this._parsePrice(node.prices?.salePrice?.value || node.prices?.basePrice?.value);
                if (gSale !== null) {
                    msrp = Math.round((gSale * 1.1) * 100) / 100;
                } else {
                    msrp = incGst;
                }
            }

            const inv = this._getInventoryInfo(
                gqlProduct.inventory,
                node.inventory,
                node.isPurchasable !== false,
            );

            return {
                id: node.entityId,
                sku: node.sku || '',
                label,
                incGst,
                exGst,
                msrp,
                inventoryStatus: inv.status,
                inventoryClass: inv.statusClass,
                availableQty: inv.availableQty,
                purchasable: inv.availableQty > 0,
            };
        });

        if (!variants.length) {
            const incGst = baseIncGst;
            const exGst = incGst !== null
                ? Math.round((incGst / 11 * 10) * 100) / 100
                : null;
            const msrp = baseMsrp ?? incGst;

            const inv = this._getInventoryInfo(gqlProduct.inventory, null, true);
            variants.push({
                id: null,
                sku: '',
                label: 'Default',
                incGst,
                exGst,
                msrp,
                inventoryStatus: inv.status,
                inventoryClass: inv.statusClass,
                availableQty: inv.availableQty,
                purchasable: inv.availableQty > 0,
            });
        }

        return { id: productId, name: gqlProduct.name, variants };
    }

    // -------------------------------------------------------------------------
    // Private — Cart API
    // -------------------------------------------------------------------------

    async _fetchCart() {
        try {
            const res = await fetch('/api/storefront/carts', {
                credentials: 'same-origin',
                headers: { Accept: 'application/json' },
            });
            if (!res.ok) return null;
            const carts = await res.json();
            return Array.isArray(carts) && carts.length ? carts[0] : null;
        } catch { return null; }
    }

    async _addLineItems(lineItems) {
        const cart = await this._fetchCart();
        const url = cart
            ? `/api/storefront/carts/${cart.id}/items`
            : '/api/storefront/carts';

        const res = await fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify({ lineItems }),
        });

        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.title || `Cart error (${res.status})`);
        }

        return res.json();
    }

    async _refreshCartCount() {
        try {
            const res = await fetch('/api/storefront/carts?include=lineItems.physicalItems', {
                credentials: 'same-origin',
            });
            const carts = await res.json();
            if (!Array.isArray(carts) || !carts.length) return;
            const qty = (carts[0].lineItems.physicalItems || [])
                .reduce((sum, item) => sum + item.quantity, 0);
            $('body').trigger('cart-quantity-update', qty);
        } catch { /* best-effort */ }
    }

    // -------------------------------------------------------------------------
    // Private — Rendering
    // -------------------------------------------------------------------------

    _buildModalHtml(product) {
        const { id, name, variants } = product;
        const hasSkus = variants.some(v => v.sku);
        const anyAvailable = variants.some(v => v.availableQty > 0);

        const rows = variants.map(v => {
            const isOos = v.availableQty <= 0;
            const maxAttr = v.availableQty > 0 ? `max="${v.availableQty}"` : 'max="0"';
            const disabledAttr = isOos ? 'disabled placeholder="0"' : '';

            return `
            <tr class="b2bModal-row ${isOos ? 'b2bModal-row--outOfStock' : ''}">
                <td class="b2bModal-cell b2bModal-cell--variant">${this._esc(v.label)}</td>
                ${hasSkus ? `<td class="b2bModal-cell b2bModal-cell--sku">${this._esc(v.sku || '—')}</td>` : ''}
                <td class="b2bModal-cell b2bModal-cell--price">${this._formatCurrency(v.incGst)}</td>
                <td class="b2bModal-cell b2bModal-cell--price">${this._formatCurrency(v.exGst)}</td>
                <td class="b2bModal-cell b2bModal-cell--msrp">${this._formatCurrency(v.msrp)}</td>
                <td class="b2bModal-cell b2bModal-cell--stock">
                    <span class="b2bModal-stock b2bModal-stock--${v.inventoryClass}">${this._esc(v.inventoryStatus)}</span>
                </td>
                <td class="b2bModal-cell b2bModal-cell--qty">
                    <input class="b2bModal-qtyInput"
                           type="number"
                           data-variant-id="${v.id !== null ? v.id : ''}"
                           data-variant-label="${this._esc(v.label)}"
                           data-available-qty="${v.availableQty}"
                           value="0"
                           min="0"
                           ${maxAttr}
                           step="1"
                           ${disabledAttr}
                           aria-label="Quantity for ${this._esc(v.label)}">
                </td>
            </tr>`;
        }).join('');

        return `
            <div class="b2bModal modal-body">
                <div class="b2bModal-header">
                    <div class="b2bModal-meta">
                        <h2 class="b2bModal-title">${this._esc(name)}</h2>
                    </div>
                </div>

                <form class="b2bModal-form" data-b2b-order-form data-product-id="${id}" novalidate>
                    <div class="b2bModal-tableWrap">
                        <table class="b2bModal-table">
                            <thead>
                                <tr>
                                    <th class="b2bModal-th">Variant</th>
                                    ${hasSkus ? '<th class="b2bModal-th">SKU</th>' : ''}
                                    <th class="b2bModal-th b2bModal-th--price">inc GST</th>
                                    <th class="b2bModal-th b2bModal-th--price">ex GST</th>
                                    <th class="b2bModal-th b2bModal-th--msrp">MSRP</th>
                                    <th class="b2bModal-th b2bModal-th--stock">Stock</th>
                                    <th class="b2bModal-th b2bModal-th--qty">Qty</th>
                                </tr>
                            </thead>
                            <tbody>${rows}</tbody>
                        </table>
                    </div>

                    <div class="b2bModal-footer">
                        <p class="b2bModal-feedback" aria-live="polite" role="status"></p>
                        <div class="b2bModal-footerActions">
                            <a href="/cart.php" class="button button--secondary b2bModal-viewCart" hidden>View Cart</a>
                            <button type="submit" class="button button--primary b2bModal-submit" ${!anyAvailable ? 'disabled' : ''}>
                                ${anyAvailable ? 'Add to Cart' : 'Out of Stock'}
                            </button>
                        </div>
                    </div>
                </form>
            </div>`;
    }

    _loadingHtml(name) {
        return `
            <div class="b2bModal modal-body">
                <div class="b2bModal-header">
                    <div class="b2bModal-meta">
                        <h2 class="b2bModal-title">${this._esc(name)}</h2>
                    </div>
                </div>
                <p class="b2bModal-loading">Loading variants&hellip;</p>
            </div>`;
    }

    _errorHtml(msg = 'Could not load product options. Please try refreshing the page.') {
        return `
            <div class="b2bModal modal-body">
                <p class="b2bModal-error">${this._esc(msg)}</p>
            </div>`;
    }

    _esc(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // -------------------------------------------------------------------------
    // Private — Quantity Guards & Validation
    // -------------------------------------------------------------------------

    _bindQtyGuards() {
        this.modal.$content.off('input change keyup', '.b2bModal-qtyInput');
        this.modal.$content.on('input change keyup', '.b2bModal-qtyInput', (e) => {
            const $input = $(e.currentTarget);
            const max = parseInt($input.attr('max'), 10);
            const val = parseInt($input.val(), 10);
            const label = $input.data('variantLabel') || 'item';
            const $feedback = this.modal.$content.find('.b2bModal-feedback');

            if (!isNaN(val) && val < 0) {
                $input.val(0);
            } else if (!isNaN(max) && !isNaN(val) && val > max) {
                $input.val(max);
                $feedback
                    .addClass('b2bModal-feedback--error')
                    .html(`Maximum available quantity for <strong>${this._esc(label)}</strong> is <strong>${max}</strong>.`);
            }
        });
    }

    // -------------------------------------------------------------------------
    // Private — Submit
    // -------------------------------------------------------------------------

    _bindFormSubmit(productId) {
        this.modal.$content.off('submit', '[data-b2b-order-form]');
        this.modal.$content.on('submit', '[data-b2b-order-form]', async (e) => {
            e.preventDefault();
            const $form = $(e.currentTarget);
            const $submit = $form.find('.b2bModal-submit');
            const $feedback = $form.find('.b2bModal-feedback');
            const $viewCart = $form.find('.b2bModal-viewCart');

            const lineItems = [];
            let hasExcessQty = false;

            $form.find('.b2bModal-qtyInput:not(:disabled)').each((_, input) => {
                const $input = $(input);
                const qty = parseInt($input.val(), 10) || 0;
                if (qty <= 0) return;

                const max = parseInt($input.data('availableQty'), 10);
                const label = $input.data('variantLabel') || 'item';

                if (!isNaN(max) && qty > max) {
                    $feedback
                        .addClass('b2bModal-feedback--error')
                        .html(`Quantity for <strong>${this._esc(label)}</strong> cannot exceed available stock (${max}).`);
                    $input.focus().val(max);
                    hasExcessQty = true;
                    return false;
                }

                const rawId = $input.data('variantId');
                const variantId = rawId !== '' && rawId !== undefined ? parseInt(rawId, 10) : null;
                const lineItem = { quantity: qty, productId };
                if (variantId) lineItem.variantId = variantId;
                lineItems.push(lineItem);
            });

            if (hasExcessQty) return;

            if (!lineItems.length) {
                $feedback
                    .addClass('b2bModal-feedback--error')
                    .text('Enter a quantity for at least one variant.');
                return;
            }

            $submit.prop('disabled', true).text('Adding\u2026');
            $feedback.removeClass('b2bModal-feedback--error').text('');
            $viewCart.attr('hidden', '');

            try {
                await this._addLineItems(lineItems);
                const total = lineItems.reduce((s, i) => s + i.quantity, 0);
                $feedback
                    .removeClass('b2bModal-feedback--error')
                    .html(`&#x2713; ${total} item${total !== 1 ? 's' : ''} added to cart.`);
                $submit.prop('disabled', false).text('Add More');
                $viewCart.removeAttr('hidden');
                $form.find('.b2bModal-qtyInput:not(:disabled)').val(0);
                this._refreshCartCount();
            } catch (err) {
                $feedback
                    .addClass('b2bModal-feedback--error')
                    .text(err.message || 'Could not add to cart. Please try again.');
                $submit.prop('disabled', false).text('Add to Cart');
            }
        });
    }
}
