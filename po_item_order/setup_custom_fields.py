import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

CUSTOM_FIELDS = {
    "Purchase Order": [
        {
            "fieldname": "custom_brand",
            "label": "Brand",
            "fieldtype": "Link",
            "options": "Brand",
            "insert_after": "supplier",
            "description": "Filter or order items specifically for this brand",
        },
        {
            "fieldname": "custom_manufacturer",
            "label": "Manufacturer",
            "fieldtype": "Link",
            "options": "Manufacturer",
            "insert_after": "custom_brand",
            "description": "Filter or order items specifically from this manufacturer",
        },
    ],
    "Request for Quotation": [
        {
            "fieldname": "custom_brand",
            "label": "Brand",
            "fieldtype": "Link",
            "options": "Brand",
            "insert_after": "company",
            "description": "Filter or request items specifically for this brand",
        },
        {
            "fieldname": "custom_manufacturer",
            "label": "Manufacturer",
            "fieldtype": "Link",
            "options": "Manufacturer",
            "insert_after": "custom_brand",
            "description": "Filter or request items specifically from this manufacturer",
        },
    ]
}

def setup_custom_fields():
    create_custom_fields(CUSTOM_FIELDS, ignore_validate=True)
    frappe.clear_cache(doctype="Purchase Order")
    frappe.clear_cache(doctype="Request for Quotation")
    print("po_item_order custom fields configured successfully.")
