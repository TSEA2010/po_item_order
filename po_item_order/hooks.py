app_name = "po_item_order"
app_title = "PO Item Order"
app_publisher = "WoolMatt ERP"
app_description = "Purchase Order Item Selector by Supplier, Brand & Manufacturer for ERPNext"
app_email = "procurement@woolmatt.com"
app_license = "mit"

# Includes in Desk
app_include_css = "/assets/po_item_order/css/quick_order.css"

# DocType JS
doctype_js = {
    "Purchase Order": "public/js/purchase_order_quick_order.js",
    "Request for Quotation": "public/js/rfq_quick_order.js"
}

# Installation & Migrations
after_install = "po_item_order.setup_custom_fields.setup_custom_fields"
after_migrate = "po_item_order.setup_custom_fields.setup_custom_fields"
