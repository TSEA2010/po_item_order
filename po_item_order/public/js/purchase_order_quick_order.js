frappe.provide('po_item_order');

frappe.ui.form.on('Purchase Order', {
    refresh: function(frm) {
        if (frm.doc.docstatus === 0) {
            // Add prominent Quick Order button on PO toolbar
            frm.add_custom_button(__('⚡ Quick Order Items'), function() {
                po_item_order.open_quick_order_dialog(frm);
            }).addClass('btn-primary-order');

            // Add under Get Items From
            frm.add_custom_button(__('Supplier / Brand / Mfr Items'), function() {
                po_item_order.open_quick_order_dialog(frm);
            }, __('Get Items From'));
        }
    },

    custom_brand: function(frm) {
        if (frm.doc.docstatus !== 0 || !frm.doc.custom_brand) {
            return;
        }
        po_item_order.handle_header_selection(frm, 'brand', frm.doc.custom_brand);
    },

    custom_manufacturer: function(frm) {
        if (frm.doc.docstatus !== 0 || !frm.doc.custom_manufacturer) {
            return;
        }
        po_item_order.handle_header_selection(frm, 'manufacturer', frm.doc.custom_manufacturer);
    },

    supplier: function(frm) {
        if (frm.doc.docstatus !== 0 || !frm.doc.supplier) {
            return;
        }
        // If a brand is already set, do not override unless items are empty
        let has_real_items = frm.doc.items && frm.doc.items.some(r => r.item_code);
        if (!has_real_items && !frm.doc.custom_brand && !frm.doc.custom_manufacturer) {
            po_item_order.handle_header_selection(frm, 'supplier', frm.doc.supplier);
        }
    }
});

/**
 * Handle when user selects Brand, Manufacturer or Supplier in PO header
 */
po_item_order.handle_header_selection = function(frm, field_type, field_value) {
    let has_real_items = frm.doc.items && frm.doc.items.some(r => r.item_code);

    let type_label = field_type === 'brand' ? __('Brand') : (field_type === 'manufacturer' ? __('Manufacturer') : __('Supplier'));

    if (has_real_items) {
        frappe.confirm(
            __('The Purchase Order already has items.<br><br>Do you want to <b>Replace</b> them with all items from {0} <b>{1}</b>?<br><small class="text-muted">(Click "No" to Append instead)</small>', [type_label, field_value]),
            function() {
                // User chose Replace
                po_item_order.fetch_and_load_items(frm, { [field_type]: field_value }, true, `${type_label} ${field_value}`);
            },
            function() {
                // User chose Append
                po_item_order.fetch_and_load_items(frm, { [field_type]: field_value }, false, `${type_label} ${field_value}`);
            }
        );
    } else {
        // Table is empty or has only 1 blank row: Load immediately with no extra prompt
        po_item_order.fetch_and_load_items(frm, { [field_type]: field_value }, true, `${type_label} ${field_value}`);
    }
};

/**
 * Fetch items from API and load them into the PO items table
 */
po_item_order.fetch_and_load_items = function(frm, filters, replace, label) {
    frappe.show_alert({
        message: __('Fetching items for {0}...', [label]),
        indicator: 'blue'
    }, 3);

    frappe.call({
        method: 'po_item_order.api.get_orderable_items',
        args: {
            supplier: filters.supplier || frm.doc.supplier,
            brand: filters.brand || frm.doc.custom_brand,
            manufacturer: filters.manufacturer || frm.doc.custom_manufacturer,
            warehouse: frm.doc.set_warehouse,
            company: frm.doc.company,
            limit: 400
        },
        callback: function(r) {
            if (!r.message || !r.message.items || r.message.items.length === 0) {
                frappe.msgprint({
                    title: __('No Items Found'),
                    message: __('No purchasable items were found matching {0}.', [label]),
                    indicator: 'orange'
                });
                return;
            }

            let items = r.message.items;
            let total = r.message.total;

            // If brand has a huge catalog (>150 items), ask if user wants Quick Order Sheet or first 100
            if (total > 150) {
                frappe.confirm(
                    __('Found <b>{0} items</b> for {1}. Loading all of them directly may slow down your screen.<br><br>Would you like to open the <b>Quick Order Sheet</b> to filter and pick items, or load the first 100 items directly?', [total, label]),
                    function() {
                        po_item_order.open_quick_order_dialog(frm, filters);
                    },
                    function() {
                        po_item_order.populate_items_into_frm(frm, items.slice(0, 100), replace, `${label} (Top 100)`);
                    }
                );
            } else {
                po_item_order.populate_items_into_frm(frm, items, replace, label);
            }

            // If supplier is not set and this is a brand/mfr, check if there is an associated supplier
            if (!frm.doc.supplier && filters.brand) {
                frappe.call({
                    method: 'po_item_order.api.get_supplier_brand_summary',
                    args: { brand: filters.brand },
                    callback: function(s) {
                        if (s.message && s.message.associated_suppliers && s.message.associated_suppliers.length > 0) {
                            let suggested_supplier = s.message.associated_suppliers[0].supplier;
                            if (suggested_supplier) {
                                frm.set_value('supplier', suggested_supplier);
                            }
                        }
                    }
                });
            }
        }
    });
};

/**
 * Populate item rows into frm.doc.items
 */
po_item_order.populate_items_into_frm = function(frm, items, replace, label) {
    if (!items || items.length === 0) return;

    function apply_rows(wh) {
        if (wh && !frm.doc.set_warehouse) {
            frm.set_value('set_warehouse', wh);
        }

        let target_warehouse = wh || frm.doc.set_warehouse || '';

        if (replace) {
            frm.clear_table('items');
        } else {
            // Remove any blank rows that have no item_code
            frm.doc.items = (frm.doc.items || []).filter(r => r.item_code);
        }

        let schedule_date = frm.doc.schedule_date || frappe.datetime.nowdate();
        let added_count = 0;

        items.forEach(it => {
            // Check if already in items table
            let existing = frm.doc.items ? frm.doc.items.find(r => r.item_code === it.item_code) : null;
            if (existing) {
                return;
            }

            let row = frm.add_child('items');
            row.item_code = it.item_code;
            row.item_name = it.item_name;
            row.qty = it.suggested_qty > 0 ? it.suggested_qty : 1.0;
            row.rate = flt(it.rate);
            row.uom = it.purchase_uom || it.stock_uom || 'Nos';
            row.stock_uom = it.stock_uom || 'Nos';
            row.conversion_factor = 1.0;
            row.warehouse = target_warehouse || it.warehouse;
            row.schedule_date = schedule_date;
            row.amount = flt(row.qty) * flt(row.rate);
            row.base_rate = row.rate;
            row.base_amount = row.amount;
            added_count++;
        });

        frm.refresh_field('items');

        if (frm.cscript && frm.cscript.calculate_taxes_and_totals) {
            frm.cscript.calculate_taxes_and_totals(frm);
        }
        frm.dirty();

        frappe.show_alert({
            message: __('Loaded {0} items for {1} into Purchase Order', [added_count, label]),
            indicator: 'green'
        }, 5);
    }

    // Ensure warehouse is set to avoid validation error
    if (!frm.doc.set_warehouse) {
        frappe.call({
            method: 'po_item_order.api.get_default_context',
            args: { company: frm.doc.company },
            callback: function(r) {
                let default_wh = (r.message && r.message.default_warehouse) ? r.message.default_warehouse : '';
                apply_rows(default_wh);
            }
        });
    } else {
        apply_rows(frm.doc.set_warehouse);
    }
};

/**
 * Interactive Quick Order Sheet Modal
 */
po_item_order.open_quick_order_dialog = function(frm, initial_filters) {
    initial_filters = initial_filters || {};

    let default_supplier = initial_filters.supplier || frm.doc.supplier || '';
    let default_brand = initial_filters.brand || frm.doc.custom_brand || '';
    let default_manufacturer = initial_filters.manufacturer || frm.doc.custom_manufacturer || '';
    let default_warehouse = frm.doc.set_warehouse || '';

    let d = new frappe.ui.Dialog({
        title: __('⚡ Quick Order: Select by Supplier, Brand or Manufacturer'),
        size: 'extra-large',
        fields: [
            {
                fieldtype: 'Section Break',
                label: __('Filter Items to Order')
            },
            {
                fieldname: 'supplier',
                label: __('Supplier'),
                fieldtype: 'Link',
                options: 'Supplier',
                default: default_supplier,
                onchange: function() { fetch_and_render(); }
            },
            {
                fieldtype: 'Column Break'
            },
            {
                fieldname: 'brand',
                label: __('Brand'),
                fieldtype: 'Link',
                options: 'Brand',
                default: default_brand,
                onchange: function() { fetch_and_render(); }
            },
            {
                fieldtype: 'Column Break'
            },
            {
                fieldname: 'manufacturer',
                label: __('Manufacturer'),
                fieldtype: 'Link',
                options: 'Manufacturer',
                default: default_manufacturer,
                onchange: function() { fetch_and_render(); }
            },
            {
                fieldtype: 'Section Break',
                label: __('Options & Search')
            },
            {
                fieldname: 'warehouse',
                label: __('Target Warehouse (for stock balance)'),
                fieldtype: 'Link',
                options: 'Warehouse',
                default: default_warehouse,
                onchange: function() { fetch_and_render(); }
            },
            {
                fieldtype: 'Column Break'
            },
            {
                fieldname: 'search_term',
                label: __('Search Item Code or Name'),
                fieldtype: 'Data',
                onchange: function() { fetch_and_render(); }
            },
            {
                fieldtype: 'Column Break'
            },
            {
                fieldname: 'only_low_stock',
                label: __('Show Low / Out-of-Stock Only'),
                fieldtype: 'Check',
                default: 0,
                onchange: function() { fetch_and_render(); }
            },
            {
                fieldtype: 'Section Break'
            },
            {
                fieldname: 'items_html',
                fieldtype: 'HTML'
            }
        ],
        primary_action_label: __('Add Selected to Purchase Order'),
        primary_action: function() {
            apply_to_po(false);
        },
        secondary_action_label: __('Add ALL Listed Items to PO'),
        secondary_action: function() {
            apply_to_po(true);
        }
    });

    let current_items = [];
    let debounce_timer = null;

    function fetch_and_render() {
        if (debounce_timer) clearTimeout(debounce_timer);
        debounce_timer = setTimeout(function() {
            do_fetch();
        }, 250);
    }

    function do_fetch() {
        let supplier = d.get_value('supplier');
        let brand = d.get_value('brand');
        let manufacturer = d.get_value('manufacturer');
        let warehouse = d.get_value('warehouse');
        let search_term = d.get_value('search_term');
        let only_low_stock = d.get_value('only_low_stock') ? 1 : 0;

        if (!supplier && !brand && !manufacturer && !search_term) {
            d.fields_dict.items_html.$wrapper.html(`
                <div class="text-muted text-center" style="padding: 40px; border: 1px dashed #cbd5e1; border-radius: 8px;">
                    <i class="fa fa-shopping-cart fa-3x" style="color: #94a3b8; margin-bottom: 12px;"></i>
                    <h5 style="color: #475569;">Select a Supplier, Brand, or Manufacturer above</h5>
                    <p style="font-size: 13px; color: #64748b;">All items they provide will be automatically fetched and listed here for ordering.</p>
                </div>
            `);
            current_items = [];
            return;
        }

        d.fields_dict.items_html.$wrapper.html(`
            <div class="text-center" style="padding: 30px;">
                <div class="spinner-border text-primary" role="status"></div>
                <div style="margin-top: 8px; color: #64748b; font-size: 13px;">Fetching items and real-time stock balances...</div>
            </div>
        `);

        frappe.call({
            method: 'po_item_order.api.get_orderable_items',
            args: {
                supplier: supplier,
                brand: brand,
                manufacturer: manufacturer,
                warehouse: warehouse,
                company: frm.doc.company,
                only_low_stock: only_low_stock,
                search_term: search_term,
                limit: 400
            },
            callback: function(r) {
                if (r.message && r.message.items) {
                    current_items = r.message.items;
                    render_table(r.message.items, r.message.total);
                } else {
                    current_items = [];
                    render_table([], 0);
                }
            }
        });
    }

    function render_table(items, total) {
        if (!items || items.length === 0) {
            d.fields_dict.items_html.$wrapper.html(`
                <div class="text-muted text-center" style="padding: 35px; border: 1px solid #e2e8f0; border-radius: 8px;">
                    <i class="fa fa-info-circle fa-2x" style="color: #f59e0b; margin-bottom: 8px;"></i>
                    <h5 style="color: #334155;">No matching items found</h5>
                    <p style="font-size: 13px; color: #64748b;">Try adjusting your Supplier, Brand, Manufacturer or Search term.</p>
                </div>
            `);
            return;
        }

        let html = `
            <div class="po-quick-order-container">
                <div class="po-quick-batch-bar">
                    <div class="batch-actions">
                        <button type="button" class="btn btn-xs btn-default btn-select-all">${__('Select All')}</button>
                        <button type="button" class="btn btn-xs btn-default btn-deselect-all">${__('Deselect All')}</button>
                        <span style="border-left: 1px solid #cbd5e1; height: 18px; margin: 0 4px;"></span>
                        <button type="button" class="btn btn-xs btn-default btn-suggested-qty" title="${__('Set suggested quantities based on reorder levels')}">
                            ${__('Fill Suggested Qty')}
                        </button>
                        <span style="border-left: 1px solid #cbd5e1; height: 18px; margin: 0 4px;"></span>
                        <span>${__('Set Selected Qty:')}</span>
                        <input type="number" class="bulk-qty-input" value="1" min="1" style="width: 50px; padding: 2px 4px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 4px;" />
                        <button type="button" class="btn btn-xs btn-primary btn-apply-bulk-qty">${__('Apply')}</button>
                    </div>
                    <div style="font-size: 12px; color: #64748b;">
                        <b>${items.length}</b> ${__('items displayed')} ${total > items.length ? `(${__('out of')} ${total})` : ''}
                    </div>
                </div>

                <div class="po-items-table-wrapper">
                    <table class="table table-bordered po-items-table">
                        <thead>
                            <tr>
                                <th style="width: 38px; text-align: center;">
                                    <input type="checkbox" class="header-checkbox" checked />
                                </th>
                                <th style="width: 140px;">${__('Item Code')}</th>
                                <th>${__('Item Name')}</th>
                                <th style="width: 110px;">${__('Brand / Mfr')}</th>
                                <th style="width: 95px; text-align: right;">${__('Current Stock')}</th>
                                <th style="width: 60px;">${__('UOM')}</th>
                                <th style="width: 95px; text-align: right;">${__('Est. Rate')}</th>
                                <th style="width: 125px; text-align: center;">${__('Order Qty')}</th>
                                <th style="width: 100px; text-align: right;">${__('Est. Amount')}</th>
                            </tr>
                        </thead>
                        <tbody>
        `;

        items.forEach((it, idx) => {
            let initial_qty = it.suggested_qty > 0 ? it.suggested_qty : 1;
            let est_amt = (initial_qty * it.rate).toFixed(2);
            let badge_class = it.badge_color === 'green' ? 'badge-green' : (it.badge_color === 'orange' ? 'badge-orange' : 'badge-red');

            html += `
                <tr class="item-row row-selected" data-idx="${idx}" data-item-code="${frappe.utils.escape_html(it.item_code)}">
                    <td style="text-align: center;">
                        <input type="checkbox" class="row-checkbox" checked data-idx="${idx}" />
                    </td>
                    <td>
                        <b>${frappe.utils.escape_html(it.item_code)}</b>
                    </td>
                    <td>
                        <span style="font-weight: 500;">${frappe.utils.escape_html(it.item_name)}</span>
                    </td>
                    <td>
                        ${it.brand ? `<span class="po-item-tag">${frappe.utils.escape_html(it.brand)}</span>` : ''}
                        ${it.manufacturer ? `<span class="po-item-tag" style="background:#e0f2fe; color:#0369a1;">${frappe.utils.escape_html(it.manufacturer)}</span>` : ''}
                    </td>
                    <td style="text-align: right;">
                        <span class="po-stock-badge ${badge_class}">${it.actual_qty.toFixed(0)}</span>
                    </td>
                    <td>
                        ${frappe.utils.escape_html(it.purchase_uom || it.stock_uom)}
                    </td>
                    <td style="text-align: right;">
                        <input type="number" step="any" min="0" class="item-rate-input" data-idx="${idx}" value="${it.rate}" 
                               style="width: 80px; text-align: right; border: 1px solid #cbd5e1; border-radius: 4px; padding: 2px 4px; font-size: 11px;" />
                    </td>
                    <td style="text-align: center;">
                        <div class="po-qty-stepper">
                            <button type="button" class="po-qty-btn qty-minus" data-idx="${idx}">-</button>
                            <input type="number" min="0" step="any" class="po-qty-input item-qty-input" data-idx="${idx}" value="${initial_qty}" />
                            <button type="button" class="po-qty-btn qty-plus" data-idx="${idx}">+</button>
                        </div>
                    </td>
                    <td style="text-align: right; font-weight: 600;" class="item-subtotal-td" data-idx="${idx}">
                        ${est_amt}
                    </td>
                </tr>
            `;
        });

        html += `
                        </tbody>
                    </table>
                </div>

                <div class="po-summary-footer">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <label style="margin-bottom: 0; font-weight: normal; cursor: pointer; display: flex; align-items: center; gap: 6px;">
                            <input type="checkbox" class="replace-existing-checkbox" />
                            ${__('Replace existing items in PO (uncheck to append)')}
                        </label>
                    </div>
                    <div class="summary-stats">
                        <div class="po-stat-pill">${__('Selected Items:')} <span class="stat-selected-count">${items.length}</span></div>
                        <div class="po-stat-pill">${__('Total Units:')} <span class="stat-total-units">0</span></div>
                        <div class="po-stat-pill">${__('Est. Grand Total:')} <span class="stat-grand-total">KES 0.00</span></div>
                    </div>
                </div>
            </div>
        `;

        d.fields_dict.items_html.$wrapper.html(html);
        attach_table_events();
        update_totals();
    }

    function attach_table_events() {
        let $w = d.fields_dict.items_html.$wrapper;

        // Select All / Deselect All
        $w.find('.header-checkbox').on('change', function() {
            let checked = $(this).prop('checked');
            $w.find('.row-checkbox').prop('checked', checked);
            if (checked) {
                $w.find('.item-row').addClass('row-selected');
            } else {
                $w.find('.item-row').removeClass('row-selected');
            }
            update_totals();
        });

        $w.find('.btn-select-all').on('click', function() {
            $w.find('.header-checkbox').prop('checked', true);
            $w.find('.row-checkbox').prop('checked', true);
            $w.find('.item-row').addClass('row-selected');
            update_totals();
        });

        $w.find('.btn-deselect-all').on('click', function() {
            $w.find('.header-checkbox').prop('checked', false);
            $w.find('.row-checkbox').prop('checked', false);
            $w.find('.item-row').removeClass('row-selected');
            update_totals();
        });

        // Row checkbox toggle
        $w.find('.row-checkbox').on('change', function() {
            let idx = $(this).data('idx');
            let $row = $w.find(`.item-row[data-idx="${idx}"]`);
            if ($(this).prop('checked')) {
                $row.addClass('row-selected');
            } else {
                $row.removeClass('row-selected');
            }
            update_totals();
        });

        // Quantity Steppers
        $w.find('.qty-plus').on('click', function() {
            let idx = $(this).data('idx');
            let $input = $w.find(`.item-qty-input[data-idx="${idx}"]`);
            let val = flt($input.val()) + 1;
            $input.val(val);
            $w.find(`.row-checkbox[data-idx="${idx}"]`).prop('checked', true);
            $w.find(`.item-row[data-idx="${idx}"]`).addClass('row-selected');
            update_row_amount(idx);
            update_totals();
        });

        $w.find('.qty-minus').on('click', function() {
            let idx = $(this).data('idx');
            let $input = $w.find(`.item-qty-input[data-idx="${idx}"]`);
            let val = Math.max(0, flt($input.val()) - 1);
            $input.val(val);
            if (val === 0) {
                $w.find(`.row-checkbox[data-idx="${idx}"]`).prop('checked', false);
                $w.find(`.item-row[data-idx="${idx}"]`).removeClass('row-selected');
            }
            update_row_amount(idx);
            update_totals();
        });

        $w.find('.item-qty-input').on('input change', function() {
            let idx = $(this).data('idx');
            let val = flt($(this).val());
            if (val > 0) {
                $w.find(`.row-checkbox[data-idx="${idx}"]`).prop('checked', true);
                $w.find(`.item-row[data-idx="${idx}"]`).addClass('row-selected');
            } else {
                $w.find(`.row-checkbox[data-idx="${idx}"]`).prop('checked', false);
                $w.find(`.item-row[data-idx="${idx}"]`).removeClass('row-selected');
            }
            update_row_amount(idx);
            update_totals();
        });

        // Rate change
        $w.find('.item-rate-input').on('input change', function() {
            let idx = $(this).data('idx');
            update_row_amount(idx);
            update_totals();
        });

        // Bulk apply qty
        $w.find('.btn-apply-bulk-qty').on('click', function() {
            let bulk_val = flt($w.find('.bulk-qty-input').val()) || 1;
            $w.find('.row-checkbox:checked').each(function() {
                let idx = $(this).data('idx');
                $w.find(`.item-qty-input[data-idx="${idx}"]`).val(bulk_val);
                update_row_amount(idx);
            });
            update_totals();
        });

        // Fill suggested reorder qty
        $w.find('.btn-suggested-qty').on('click', function() {
            current_items.forEach((it, idx) => {
                let qty = it.suggested_qty > 0 ? it.suggested_qty : 1;
                $w.find(`.item-qty-input[data-idx="${idx}"]`).val(qty);
                $w.find(`.row-checkbox[data-idx="${idx}"]`).prop('checked', true);
                $w.find(`.item-row[data-idx="${idx}"]`).addClass('row-selected');
                update_row_amount(idx);
            });
            update_totals();
        });
    }

    function update_row_amount(idx) {
        let $w = d.fields_dict.items_html.$wrapper;
        let qty = flt($w.find(`.item-qty-input[data-idx="${idx}"]`).val());
        let rate = flt($w.find(`.item-rate-input[data-idx="${idx}"]`).val());
        let amt = (qty * rate).toFixed(2);
        $w.find(`.item-subtotal-td[data-idx="${idx}"]`).text(amt);
    }

    function update_totals() {
        let $w = d.fields_dict.items_html.$wrapper;
        let selected_count = 0;
        let total_units = 0;
        let grand_total = 0;

        $w.find('.row-checkbox:checked').each(function() {
            let idx = $(this).data('idx');
            let qty = flt($w.find(`.item-qty-input[data-idx="${idx}"]`).val());
            let rate = flt($w.find(`.item-rate-input[data-idx="${idx}"]`).val());
            if (qty > 0) {
                selected_count++;
                total_units += qty;
                grand_total += (qty * rate);
            }
        });

        $w.find('.stat-selected-count').text(selected_count);
        $w.find('.stat-total-units').text(total_units.toFixed(0));
        let currency = frm.doc.currency || 'KES';
        $w.find('.stat-grand-total').text(`${currency} ${format_currency(grand_total)}`);
    }

    function apply_to_po(add_all) {
        let $w = d.fields_dict.items_html.$wrapper;
        let selected_supplier = d.get_value('supplier');
        let selected_brand = d.get_value('brand');
        let selected_manufacturer = d.get_value('manufacturer');
        let selected_warehouse = d.get_value('warehouse') || frm.doc.set_warehouse;
        let replace_existing = $w.find('.replace-existing-checkbox').prop('checked');

        let to_add = [];

        current_items.forEach((it, idx) => {
            let is_checked = add_all ? true : $w.find(`.row-checkbox[data-idx="${idx}"]`).prop('checked');
            let qty = flt($w.find(`.item-qty-input[data-idx="${idx}"]`).val());
            let rate = flt($w.find(`.item-rate-input[data-idx="${idx}"]`).val());

            if (add_all && qty <= 0) {
                qty = it.suggested_qty > 0 ? it.suggested_qty : 1;
            }

            if (is_checked && qty > 0) {
                to_add.push({
                    item_code: it.item_code,
                    item_name: it.item_name,
                    qty: qty,
                    rate: rate,
                    uom: it.purchase_uom || it.stock_uom,
                    stock_uom: it.stock_uom,
                    warehouse: selected_warehouse
                });
            }
        });

        if (to_add.length === 0) {
            frappe.msgprint({
                title: __('No Items to Add'),
                message: __('Please select at least one item and ensure its quantity is greater than 0.'),
                indicator: 'orange'
            });
            return;
        }

        // Set supplier if not set
        if (!frm.doc.supplier && selected_supplier) {
            frm.set_value('supplier', selected_supplier);
        }
        if (selected_brand && frm.fields_dict['custom_brand']) {
            frm.set_value('custom_brand', selected_brand);
        }
        if (selected_manufacturer && frm.fields_dict['custom_manufacturer']) {
            frm.set_value('custom_manufacturer', selected_manufacturer);
        }

        po_item_order.populate_items_into_frm(frm, to_add, replace_existing, 'Quick Order');
        d.hide();
    }

    d.show();

    if (!default_warehouse) {
        frappe.call({
            method: 'po_item_order.api.get_default_context',
            args: { company: frm.doc.company },
            callback: function(r) {
                if (r.message && r.message.default_warehouse) {
                    default_warehouse = r.message.default_warehouse;
                    d.set_value('warehouse', default_warehouse);
                }
            }
        });
    }

    // Trigger initial fetch if filters are already populated
    if (default_supplier || default_brand || default_manufacturer) {
        fetch_and_render();
    }
};
