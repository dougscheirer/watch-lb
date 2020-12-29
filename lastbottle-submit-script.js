<script>
	// Handler when the DOM is fully loaded
	const onDOMLoaded = function() {
		const stripeForm = $('#stripe-ajax');
		const submitButton = $('#btn-place-order');
		const errorBanner = $('#stripe-error-banner');
		const spinnerOverlay = $('#cart-loading-overlay');

		// init Stripe
		const stripe = Stripe('pk_live_5zI2pqlr69qMbV2WOOOdR0Al00LPTaFHmg', {
			stripeAccount: 'acct_15fk1sBxjgh76Oq6'
		});

		// Cancel Payment intent function
		const cancelPaymentIntent = function() {
			try {
				$.ajax({
					method: 'POST',
					url: '/cart/cancel_payment_intent'
				});
			} catch (err) {}
		}

		const displayErrorBanner = function(message) {
			errorBanner.children('p').remove();
			errorBanner.prepend('<p class="ml-2 mb-0 d-inline">' + message + '</p>');
			errorBanner.show();
		}

		stripeForm.on('submit', function(e, confirmed) {
			if (confirmed) {
				// Removes preventDefault()
				$(this).unbind('submit');

				// Resubmit w/out preventDefault()
				stripeForm.trigger('submit', true)

				return true;
			}

			// Ajax to init paymentIntent
			const ajaxCall = $.ajax({
				method: 'GET',
				url: '/cart/payment_intent',
				beforeSend: function() {
					// Disable button
					submitButton.prop('disabled', true);

					// Loading Indicator
					spinnerOverlay.show();
					$('body').css('overflow', 'hidden');
					submitButton.children('strong').text('Processing Order...');
				}
			});

			ajaxCall.fail(function(_, stat, err) {
				// Re-enable button
				submitButton.prop('disabled', false);

				// Remove Loading
				spinnerOverlay.hide();
				$('body').css('overflow', 'auto');
				submitButton.children('strong').text('Place Order');

				if(err == 'Insufficient Inventory') {
					window.location.href = '/cart/empty.html';
				}

				// Request to cancel payment intent
				displayErrorBanner('Error: ' + err)
			});

			ajaxCall.done(function(data) {
				// Callback after cancelPayment ajaxCall
				const cancelCB = function(msg) {
					// Re-enable button
					submitButton.prop('disabled', false);

					// Remove Loading
					spinnerOverlay.hide();
					$('body').css('overflow', 'auto');
					submitButton.children('strong').text('Place Order');
					displayErrorBanner(msg)
					return false;
				};
				try {
					// If no data was returned from ajaxCall
					if (!data) return cancelCB('Error: Unable to connect to Payment Processor');
					// Retrieve data returned from ajax call
					const {
						status,
						stripe_pi_token
					} = JSON.parse(data);

					if (status !== 'success' || !stripe_pi_token) return cancelCB('Error: Unable to Process Payment');

					// If all necessary data was returned call Stripe's confirmCartPayment
					stripe.confirmCardPayment(stripe_pi_token).then(function(res) {
						if (res.error || !res.paymentIntent) {

							// Request to cancel payment intent
							cancelPaymentIntent();
							return cancelCB(res.error.message || 'Error: Credit Card Transaction Declined. Please contact your bank or try again with a diffrent credit card.');
						}

						const {
							id
						} = res.paymentIntent

						// Create hidden input
						stripeForm.prepend('<input type="hidden" name="data[stripe_payment_confirmation]" id="stripe_payment_confirmation"></input>')
						$('#stripe_payment_confirmation').val(id)

						// Submit Form
						stripeForm.trigger('submit', true);
					})
				} catch (e) {}
			});

			// Prevent from submitting form
			return false;
		});
	}

	// wait for jQUery to Load
	if (
		document.readyState === "complete" ||
		(document.readyState !== "loading" && !document.documentElement.doScroll)
	) {
		onDOMLoaded();
	} else {
		document.addEventListener("DOMContentLoaded", onDOMLoaded);
	}
</script>
