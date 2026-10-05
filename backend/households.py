"""Example households. The inputs are device setups; every runtime and outage
figure they are checked against lives in engine.py / data/."""
EXAMPLES = [
    dict(id="hollywood", name="Hollywood, FL household", place="broward", zip="33021", people=[
        dict(name="Marcus", devices=[
            dict(device="inogen_g5", opts=dict(batteries="2")),
            dict(device="stationary_o2", opts=dict(backup="none"))]),
        dict(name="Doreen", devices=[dict(device="airsense", opts=dict(battery="none"))]),
    ]),
    dict(id="austin", name="Austin, TX household", place="travis", zip=None, people=[
        dict(name="Priya", devices=[dict(device="astral", opts=dict(external="1"))]),
        dict(name="Garage", devices=[dict(device="generator", opts=dict(where="garage"))]),
    ]),
    dict(id="houston", name="Houston, TX household", place="harris", zip=None, people=[
        dict(name="Lena", devices=[dict(device="airsense", opts=dict(battery="converter"))]),
        dict(name="Omar", devices=[dict(device="insulin", opts=dict(cold="fridge"))]),
    ]),
]
