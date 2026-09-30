import frappe
from frappe import _

@frappe.whitelist()
def get_orderable_items(
    supplier=None,
    brand=None,
    manufacturer=None,
    warehouse=None,
    company=None,
    only_low_stock=0,
    search_term=None,
    limit=300
):
    """
    Fetch all items matching Supplier, Brand, or Manufacturer with live stock,
    last purchase rates, and reorder levels.
    """
    if not (supplier or brand or manufacturer or search_term):
        return {"items": [], "total": 0, "message": _("Please select a Supplier, Brand, or Manufacturer.")}

    conditions = ["item.disabled = 0", "item.is_purchase_item = 1"]
    values = {}

    if brand:
        conditions.append("item.brand = %(brand)s")
        values["brand"] = brand

    if manufacturer:
        conditions.append("""(
            item.default_item_manufacturer = %(manufacturer)s
            OR item.name IN (SELECT item_code FROM `tabItem Manufacturer` WHERE manufacturer = %(manufacturer)s)
        )""")
        values["manufacturer"] = manufacturer

    if supplier:
        # Resolve all items associated with this supplier:
        # 1. Item Supplier child table
        # 2. Item Default child table
        # 3. Past Purchase Orders, Receipts, Invoices
        # 4. Brand matching supplier name
        conditions.append("""(
            item.name IN (SELECT parent FROM `tabItem Supplier` WHERE supplier = %(supplier)s)
            OR item.name IN (SELECT parent FROM `tabItem Default` WHERE default_supplier = %(supplier)s)
            OR item.name IN (
                SELECT DISTINCT poi.item_code 
                FROM `tabPurchase Order Item` poi 
                JOIN `tabPurchase Order` po ON poi.parent = po.name 
                WHERE po.supplier = %(supplier)s
            )
            OR item.name IN (
                SELECT DISTINCT pri.item_code 
                FROM `tabPurchase Receipt Item` pri 
                JOIN `tabPurchase Receipt` pr ON pri.parent = pr.name 
                WHERE pr.supplier = %(supplier)s
            )
            OR item.name IN (
                SELECT DISTINCT rqi.item_code 
                FROM `tabRequest for Quotation Item` rqi 
                JOIN `tabRequest for Quotation Supplier` rqs ON rqi.parent = rqs.parent 
                WHERE rqs.supplier = %(supplier)s
            )
            OR item.brand = %(supplier)s
            OR item.brand IN (
                SELECT name FROM `tabBrand` 
                WHERE name LIKE concat('%%', %(supplier)s, '%%') 
                   OR %(supplier)s LIKE concat('%%', name, '%%')
            )
        )""")
        values["supplier"] = supplier

    if search_term:
        conditions.append("(item.name LIKE %(search)s OR item.item_name LIKE %(search)s OR item.item_group LIKE %(search)s)")
        values["search"] = f"%{search_term}%"

    where_str = " AND ".join(conditions)

    # Bin subquery for stock
    bin_warehouse_filter = ""
    reorder_warehouse_filter = ""
    if warehouse:
        bin_warehouse_filter = "AND bin.warehouse = %(warehouse)s"
        reorder_warehouse_filter = "AND ir.warehouse = %(warehouse)s"
        values["warehouse"] = warehouse
    elif company:
        bin_warehouse_filter = "AND bin.warehouse IN (SELECT name FROM `tabWarehouse` WHERE company = %(company)s)"
        values["company"] = company

    # Supplier-specific last purchase rate subquery
    supplier_rate_subquery = ""
    if supplier:
        supplier_rate_subquery = f""",
            (
                SELECT poi.rate 
                FROM `tabPurchase Order Item` poi 
                JOIN `tabPurchase Order` po ON poi.parent = po.name 
                WHERE poi.item_code = item.name 
                  AND po.supplier = %(supplier)s 
                  AND po.docstatus = 1 
                ORDER BY po.transaction_date DESC, po.creation DESC 
                LIMIT 1
            ) as supplier_last_rate
        """

    query = f"""
        SELECT 
            item.name as item_code,
            item.item_name,
            item.item_group,
            item.brand,
            item.default_item_manufacturer as manufacturer,
            item.stock_uom,
            item.purchase_uom,
            IFNULL(item.last_purchase_rate, 0.0) as last_purchase_rate,
            IFNULL(item.standard_rate, 0.0) as standard_rate,
            IFNULL(item.valuation_rate, 0.0) as valuation_rate
            {supplier_rate_subquery},
            (
                SELECT IFNULL(SUM(bin.actual_qty), 0)
                FROM `tabBin` bin
                WHERE bin.item_code = item.name
                {bin_warehouse_filter}
            ) as actual_qty,
            (
                SELECT IFNULL(MAX(ir.warehouse_reorder_level), 0)
                FROM `tabItem Reorder` ir
                WHERE ir.parent = item.name
                {reorder_warehouse_filter}
            ) as reorder_level,
            (
                SELECT IFNULL(MAX(ir.warehouse_reorder_qty), 0)
                FROM `tabItem Reorder` ir
                WHERE ir.parent = item.name
                {reorder_warehouse_filter}
            ) as reorder_qty
        FROM `tabItem` item
        WHERE {where_str}
        ORDER BY item.item_name ASC
    """

    raw_items = frappe.db.sql(query, values, as_dict=True)

    try:
        limit_val = int(limit) if limit else 300
    except (ValueError, TypeError):
        limit_val = 300

    results = []
    for row in raw_items:
        actual_qty = float(row.get("actual_qty") or 0.0)
        reorder_level = float(row.get("reorder_level") or 0.0)
        reorder_qty = float(row.get("reorder_qty") or 0.0)

        # Filter only low stock if requested
        if only_low_stock and int(only_low_stock) == 1:
            if reorder_level > 0 and actual_qty > reorder_level:
                continue
            elif reorder_level == 0 and actual_qty > 0:
                continue

        # Effective buying rate preference:
        # 1. Supplier's last agreed rate
        # 2. General last_purchase_rate
        # 3. standard_rate
        # 4. valuation_rate
        effective_rate = 0.0
        if row.get("supplier_last_rate") and float(row.get("supplier_last_rate")) > 0:
            effective_rate = float(row.get("supplier_last_rate"))
        elif row.get("last_purchase_rate") and float(row.get("last_purchase_rate")) > 0:
            effective_rate = float(row.get("last_purchase_rate"))
        elif row.get("standard_rate") and float(row.get("standard_rate")) > 0:
            effective_rate = float(row.get("standard_rate"))
        elif row.get("valuation_rate") and float(row.get("valuation_rate")) > 0:
            effective_rate = float(row.get("valuation_rate"))

        # Suggested order quantity
        suggested_qty = 0.0
        if reorder_qty > 0 and actual_qty <= reorder_level:
            suggested_qty = reorder_qty
        elif actual_qty <= 0:
            suggested_qty = 10.0  # sensible default
        else:
            suggested_qty = 1.0

        # Stock status badge
        if actual_qty <= 0:
            stock_status = "Out of Stock"
            badge_color = "red"
        elif reorder_level > 0 and actual_qty <= reorder_level:
            stock_status = "Low Stock"
            badge_color = "orange"
        else:
            stock_status = "In Stock"
            badge_color = "green"

        results.append({
            "item_code": row.get("item_code"),
            "item_name": row.get("item_name"),
            "item_group": row.get("item_group"),
            "brand": row.get("brand") or "",
            "manufacturer": row.get("manufacturer") or "",
            "stock_uom": row.get("stock_uom") or "Nos",
            "purchase_uom": row.get("purchase_uom") or row.get("stock_uom") or "Nos",
            "actual_qty": actual_qty,
            "reorder_level": reorder_level,
            "reorder_qty": reorder_qty,
            "rate": effective_rate,
            "suggested_qty": suggested_qty,
            "stock_status": stock_status,
            "badge_color": badge_color,
        })

    total_count = len(results)
    limited_results = results[:limit_val] if limit_val > 0 else results

    return {
        "items": limited_results,
        "total": total_count,
        "is_truncated": total_count > limit_val
    }


@frappe.whitelist()
def get_supplier_brand_summary(supplier=None, brand=None):
    """
    Get associated brands for a supplier, or associated suppliers for a brand.
    """
    summary = {
        "associated_brands": [],
        "associated_suppliers": []
    }
    if supplier:
        brands = frappe.db.sql("""
            SELECT DISTINCT item.brand, count(*) as count
            FROM `tabItem` item
            WHERE item.brand IS NOT NULL AND item.brand != ''
              AND item.disabled = 0
              AND (
                  item.name IN (SELECT parent FROM `tabItem Supplier` WHERE supplier = %(supplier)s)
                  OR item.name IN (SELECT parent FROM `tabItem Default` WHERE default_supplier = %(supplier)s)
                  OR item.name IN (SELECT poi.item_code FROM `tabPurchase Order Item` poi JOIN `tabPurchase Order` po ON poi.parent = po.name WHERE po.supplier = %(supplier)s)
                  OR item.name IN (SELECT pri.item_code FROM `tabPurchase Receipt Item` pri JOIN `tabPurchase Receipt` pr ON pri.parent = pr.name WHERE pr.supplier = %(supplier)s)
                  OR item.name IN (SELECT rqi.item_code FROM `tabRequest for Quotation Item` rqi JOIN `tabRequest for Quotation Supplier` rqs ON rqi.parent = rqs.parent WHERE rqs.supplier = %(supplier)s)
                  OR item.brand = %(supplier)s
                  OR item.brand IN (SELECT name FROM `tabBrand` WHERE name LIKE concat('%%', %(supplier)s, '%%'))
              )
            GROUP BY item.brand
            ORDER BY count DESC
        """, {"supplier": supplier}, as_dict=True)
        summary["associated_brands"] = brands

    if brand:
        suppliers = frappe.db.sql("""
            SELECT DISTINCT suppl.supplier, count(*) as count
            FROM `tabItem Supplier` suppl
            JOIN `tabItem` item ON suppl.parent = item.name
            WHERE item.brand = %(brand)s
            GROUP BY suppl.supplier
            ORDER BY count DESC
        """, {"brand": brand}, as_dict=True)
        summary["associated_suppliers"] = suppliers

    return summary


@frappe.whitelist()
def get_default_context(company=None):
    """
    Get company default warehouse and currency to assist PO item ordering.
    """
    if not company:
        company = frappe.defaults.get_user_default("Company") or frappe.db.get_single_value("Global Defaults", "default_company")
    
    default_warehouse = frappe.db.get_single_value("Stock Settings", "default_warehouse")
    if not default_warehouse or not frappe.db.exists("Warehouse", {"name": default_warehouse, "company": company, "is_group": 0}):
        whs = frappe.get_all("Warehouse", filters={"company": company, "is_group": 0}, pluck="name", limit=1)
        default_warehouse = whs[0] if whs else None

    return {
        "company": company,
        "default_warehouse": default_warehouse,
        "currency": frappe.get_cached_value("Company", company, "default_currency") if company else "KES"
    }

