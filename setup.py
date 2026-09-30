from setuptools import setup, find_packages

setup(
    name="po_item_order",
    version="1.0.0",
    description="Purchase Order Item Selector by Supplier, Brand & Manufacturer for ERPNext",
    author="WoolMatt ERP",
    author_email="procurement@woolmatt.com",
    packages=find_packages(),
    zip_safe=False,
    include_package_data=True,
    install_requires=[],
)
