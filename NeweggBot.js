const puppeteer = require('puppeteer-extra')
const stealthPlugin = require('puppeteer-extra-plugin-stealth')
const readline = require("readline")
const log4js = require("log4js")
const config = require('./config.json')

log4js.configure({
	appenders: {
		out: { type: 'stdout' },
		app: { type: 'file', filename: 'application.log' }
	},
	categories: {
		default: { appenders: [ 'out', 'app' ], level: 'trace' }
	}
})

const logger = log4js.getLogger("Newegg Shopping Bot")
logger.level = "trace"

var TFA_wait = config.TFA_base_wait
var do_oos_item_removal = false
var oos_item_found = false

/**
 * Sign into wegg
 * @param {*} page The page containing the element
 */
async function signin(page, rl, tryTimes = 3) {
	//probably want to change code to looking at the specific html elements for determining which step/field page is asking for
	
	//look for email field and input email
	try {
		await page.waitForSelector('#labeled-input-signEmail', { timeout: 2500 })
		await page.waitForSelector('button.btn.btn-orange', { timeout: 2500 })
		await page.type('#labeled-input-signEmail', config.email)
		await page.click('button.btn.btn-orange')
	} catch (signEmailInputErr) {
		logger.error("No email selector found")
	}
	
	await page.waitForTimeout(1500)
	
	//look for password field and input password
	try {
		await page.waitForSelector('#labeled-input-password', { timeout: 2500 })
		await page.waitForSelector('button.btn.btn-orange')
		await page.type('#labeled-input-password', config.password)
		await page.click('button.btn.btn-orange')
		
		await page.waitForTimeout(1500)
		
		try {
			await page.waitForSelector('#labeled-input-password', { timeout: 500 })
		} catch (passwordSelectorErr) {
			logger.trace("Logged in")
			TFA_wait = config.TFA_base_wait
			return true
		}
	} catch (passwordInputErr) {
		//Waiting 30-60s and reloading allows a bypass of 2FA
		if (config.skip_TFA && !config.do_first_TFA) {
			logger.warn(`email 2FA is being asked, will reload in ${TFA_wait}s to skip it`)
			await page.waitForTimeout(TFA_wait * 1000)
			TFA_wait = Math.min(TFA_wait + config.TFA_wait_add, config.TFA_wait_cap)

			if (!page.url().includes('signin')) {
				logger.info("2FA inputted while waiting")
				logger.trace("Logged in")
				TFA_wait = config.TFA_base_wait
				return true
			}
			
			if (tryTimes > 0) {
				await page.click('a.signin-steps-back')
				await page.waitForTimeout(1500)

				await page.waitForSelector('#labeled-input-signEmail', { timeout: 2500 })
				await page.waitForSelector('button.btn.btn-orange', { timeout: 2500 })
				await page.click('button.btn.btn-orange')
				await page.waitForTimeout(1500)
		
				return await signin(page, rl, tryTimes - 1)
			}

			return false
		}

		logger.warn("Manual authorization code required by Newegg.  This should only happen once.")

		var tempFACode = true

		while (page.url().includes('signin')) {
			if (tempFACode == true) {
				tempFACode = false
				
				rl.question('What is the 6 digit 2FA code? ', async function(FACode) {
					logger.info(`Inputting code ${FACode} into 2FA field`)
					
					await page.waitForSelector('input[aria-label="verify code 1"]')
					await page.waitForSelector('input[aria-label="verify code 2"]')
					await page.waitForSelector('input[aria-label="verify code 3"]')
					await page.waitForSelector('input[aria-label="verify code 4"]')
					await page.waitForSelector('input[aria-label="verify code 5"]')
					await page.waitForSelector('input[aria-label="verify code 6"]')
					await page.waitForSelector('#signInSubmit', { timeout: 2500 })
					
					await page.type('input[aria-label="verify code 1"]', FACode)
					await page.waitForTimeout(500)
					await page.click('#signInSubmit')
					await page.waitForTimeout(2500)
					
					tempFACode = true
				})
			}
			
			await page.waitForTimeout(500)
		}
		
		logger.trace("Logged in")
		config.do_first_TFA=false
		TFA_wait = config.TFA_base_wait

		return true
	}
	
	return false
}

/**
 * Check the wishlist and see if the "Add to Cart" button is disabled or not, then press it
 * @param {*} page The page containing the element
 */
async function check_wishlist(page) {
	const buttonElementName = 'button.btn.btn-primary.btn-large.list-subtotal-button'
	try {
		//find a non disabled subtotal button, if none is found then errors out
		await page.waitForSelector(buttonElementName, { timeout: 2000 })
		if (await page.evaluate(element => element.disabled, await page.$(buttonElementName)) == true) throw 'No items found'
	} catch (err) {
		logger.error(err)
		await dynamicTimeout(page)
		return false
	}

	await page.click(buttonElementName)
	logger.trace("Item(s) added to cart, checking cart")
	return true
}

/**
 * Check the cart and make sure the subtotal is within the max price
 * @param {*} page The page containing the element
 */
async function check_cart(page, removed = false) {
	const amountElementName = '.summary-content-total'
	try {
		await page.waitForSelector(amountElementName, { timeout: 10000 })
		var text = await page.evaluate(element => element.textContent, await page.$(amountElementName))
		var price = parseInt(text.split('$')[1])

		//taking a guess that item quantity increases when adding OOS items and when it comes in stock it'll have maxed quantity
		//thus, am cleaning it on every search
		//oos_item_removal(page)
		
		if (price > 0)
			logger.info(`Subtotal of cart is ${price}`)

		if (price === 0) {
			if (removed)
				logger.error("The last item removed exceeds the max price, cannot purchase item")
			else if (config.use_itemlist) {
				logger.error("No items were found in stock")
				await dynamicTimeout(page)
			}
			else
				logger.error("There are no items in the cart, item possibly went out of stock when adding to cart")
			
			//await oos_removal_disable(page)
			return false
		} else if (price > config.price_limit) {
			if (config.over_price_limit_behavior === "stop") {
				logger.error("Subtotal exceeds limit, stopping Newegg Shopping Bot process")
				
				while (true) {
					await page.waitForTimeout(500)
				}
			} else if (config.over_price_limit_behavior === "remove") {
				logger.warn("Subtotal exceeds limit, removing an item from cart")
				
				await page.waitForSelector('button.btn.btn-mini.btn-tertiary', { timeout: 5000 })
				var button = await page.$$('button.btn.btn-mini')
				await button[2].click()
				
				logger.trace("Successfully removed an item, checking cart")
				await page.waitForTimeout(500)

				//await oos_removal_disable(page)
				return await check_cart(page, true)
			} else {
				logger.error("Price exceeds limit")
			}
			
			//await oos_removal_disable(page)
			return false
		}
		
		//await oos_removal_disable(page)
		logger.trace("Cart checked, attempting to purchase")
		return true
	} catch (err) {
		//await oos_removal_disable(page)
		logger.error(err.message)
		return false
	}
}

/**
 * Remove the out of stock popup that when adding a OOS item to cart
 * @param {*} page The page containing the element
 */
async function oos_item_removal(page) {
	do_oos_item_removal = true
	oos_item_found = true
	var foundItem = false
	while (true) {
		foundItem = false
		try {
			await page.waitForFunction('document.querySelector("body").innerText.includes("Before You Continue...")', { timeout: 5000 })
			const [button] = await page.$x("//button[contains(., 'ITEM(S)')]")
			if (button) {
				foundItem = true
				logger.info("Remove OOS Item")
				await button.click()
			}
		} catch (err) {
			logger.info("no oos popup")
		}
		await page.waitForTimeout(500)
		
		oos_item_found = foundItem
		if (do_oos_item_removal == false && foundItem == false)
			break
	}
}

/**
 * disables and waits for the OOS item removal to finish
 * @param {*} page The page containing the element
 */
async function oos_removal_disable(page) {
	do_oos_item_removal = false
	while (oos_item_found) {
		await page.waitForTimeout(500)
	}
	
	await page.waitForTimeout(1000)
}

/**
 * Waits for a dynamic timeout based on the config refresh_time/randomized_wait_ceiling
 * @param {*} page The page containing the element
 */
async function dynamicTimeout(page) {
	var nextCheckInSeconds = config.refresh_time + Math.floor(Math.random() * Math.floor(config.randomized_wait_ceiling))
	logger.info(`The next attempt will be performed in ${nextCheckInSeconds} seconds`)
	await page.waitForTimeout(nextCheckInSeconds * 1000)
}

/**
 * Input the Credit Verification Value (CVV)
 * @param {*} page The page containing the element
 */
async function inputCVV(page) {
	while (true) {
		logger.info("Waiting for CVV input element")
		try {
			await page.waitForSelector("[placeholder='CVV2']", { timeout: 3000 })
			await page.focus("[placeholder='CVV2']", { timeout: 5000 })
			await page.type("[placeholder='CVV2']", config.cv2)
			logger.info("CVV data inputted")
			break
		} catch (err) {
			logger.warn("Cannot find CVV input element")
		}
	}
	
	if (config.multi_step_order == false)
		return true
	
	await page.waitForTimeout(250)
	try {
		const [button] = await page.$x("//button[contains(., 'Review your order')]")
		if (button) {
			logger.info("Review Order")
			await button.click()
		}
	} catch (err) {
		logger.error("Cannot find the Review Order button")
		logger.error(err)
	}
}

/**
 * Submit the order
 * @param {*} page The page containing the order form
 */
async function submitOrder(page) {
	await page.waitForSelector('#btnCreditCard:not([disabled])', { timeout: 3000 })
	await page.waitForTimeout(500)
	
	if (config.auto_submit) {
		await page.click('#btnCreditCard')
		logger.info("Completed purchase")
	} else {
		logger.warn("Order not submitted because 'auto_submit' is not enabled")
	}
}

async function run() {
	logger.info("Newegg Shopping Bot Started")
	logger.info("Please don't scalp, just get whatever you need for yourself")

	//#block-insecure-private-network-requests
	//#enable-web-authentication-cable-v2-support
	//#allow-sxg-certs-without-extension
	//#same-site-by-default-cookies
	//#cookies-without-same-site-must-be-secure
	//#safe-browsing-enhanced-protection-message-in-interstitials
	//#dns-httpssvc
	//#trust-tokens
	//#use-first-party-set
	//#enable-network-logging-to-file
	puppeteer.use(stealthPlugin())
	const browser = await puppeteer.launch({
		headless: config.headless,
		defaultViewport: { width: 1920, height: 1080 },
		executablePath: config.browser_executable_path,
		userDataDir: "./myDataDir",
		args: [
			'--unsafely-treat-insecure-origin-as-secure=http://example.com'
		]
	})
	const [page] = await browser.pages()
	await page.setCacheEnabled(true)

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout
	})

	//Needed for itemlist based operations, wishlist based automatically asks for signin
	await page.goto('https://secure.newegg.' + config.site_domain, {waitUntil: 'networkidle0' })
	await page.goto('https://secure.newegg.' + config.site_domain + '/NewMyAccount/AccountLogin.aspx?nextpage=https%3a%2f%2fwww.newegg.' + config.site_domain + '%2f' , {waitUntil: 'networkidle0' })
	await signin(page, rl)

	// Main loop
	while (true) {
		try {
			if (config.use_itemlist)
				await page.goto('https://secure.newegg.' + config.site_domain + '/Shopping/AddtoCart.aspx?Submit=ADD&ItemList=' + config.itemlist, { waitUntil: 'networkidle0' })
			else
				await page.goto('https://secure.newegg.' + config.site_domain + '/wishlist/md/' + config.wishlist, { waitUntil: 'networkidle0' })

			//add option for "dentity/sessionexpire"
			if (config.use_itemlist == false && page.url().includes("/wishlist/md/")) {
				if (await check_wishlist(page) && await check_cart(page)) break
			} else if (config.use_itemlist == true && (page.url().includes("/Shop/Cart") || page.url().includes("/shop/cart"))) {
				if (await check_cart(page)) break
			} else if (page.url().includes("signin")) {
				//need to signin every so often
				await signin(page, rl)
			} else if (page.url().includes("areyouahuman")) {
				logger.error("Human captcha test, waiting 1s and reloading")
				await page.waitForTimeout(1000)
			} else {
				logger.error(`redirected to "${page.url()}" for some reason`)
				await page.waitForTimeout(1000)
			}
		} catch (err) {
			logger.error(err)
			continue
		}
	}
	
	//At one point was made to run async, might change functions for running non-async to not run inefficient code
	oos_item_removal(page)
	await oos_removal_disable(page)
	
	rl.close()
	//need to make a thing: "I'm not interested." search for that button cuz covid popup thing

	// Continuely attempts to press the Checkout/Continue checkout buttons, until getting to last checkout button
	// This way no tme is wasted in saying "Wait 10s" after pressing a button, no easy way to wait for networkidle after an ajax request
	while (true) {
		try {
			let button
			
			if (page.url().includes("Cart") || page.url().includes("cart")) {
				button = await page.waitForXPath("//button[contains(., 'Secure Checkout')]", { timeout: 1000 })
			} else if (page.url().includes("checkout")) {
				button = await page.waitForXPath("//button[contains(., 'Continue to')]", { timeout: 1000 })
			} else {
				await page.waitForTimeout(1000)
				continue
			}
			
			await page.waitForTimeout(500)
			
			if (button) {
				await button.click()
			}
		} catch (err) {
			try {
				if (config.multi_step_order) {
					await page.waitForXPath("//button[contains(., 'Review your order')]", { timeout: 500 })
					break
				} else {
					await page.waitForSelector('#btnCreditCard:not([disabled])', { timeout: 500 })
					break
				}
			} catch (err) {
				continue
			}
		}
	}

	//CVV and order submit stuff
	try {
		await inputCVV(page)
		await submitOrder(page)
	} catch (err) {
		logger.error("Cannot find the Place Order button")
		logger.warn("Please make sure that your Newegg account defaults for: shipping address, billing address, and payment method have been set.")
	}
}

run()
