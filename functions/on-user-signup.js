// functions/on-user-signup.js
// This function is called by an Nhost Event Trigger when a new user signs up in auth.users.
// It creates a corresponding record in your public.user_profiles table.

// Ensure you have 'node-fetch' listed in your function's package.json
// or use Nhost's built-in 'isomorphic-fetch' if available for your Node.js version.
// Nhost provides environment variables like NHOST_GRAPHQL_URL and NHOST_ADMIN_SECRET to functions.
const fetch = require('node-fetch');

module.exports = async (req, res) => {
    const { event } = req.body;

    // These environment variables are set by Nhost and are available to your function
    const HASURA_GRAPHQL_ADMIN_SECRET = process.env.NHOST_ADMIN_SECRET;
    const HASURA_GRAPHQL_URL = process.env.NHOST_GRAPHQL_URL; // Or construct it if Nhost provides subdomain/region

    if (!HASURA_GRAPHQL_URL || !HASURA_GRAPHQL_ADMIN_SECRET) {
        console.error("Function environment variables NHOST_GRAPHQL_URL or NHOST_ADMIN_SECRET are not set.");
        return res.status(500).send("Internal server configuration error in function.");
    }

    if (!event || !event.data || !event.data.new) {
        console.error('Invalid event payload received by on-user-signup function:', JSON.stringify(req.body, null, 2));
        return res.status(400).send('Invalid event payload');
    }

    const nhostUser = event.data.new; // Data from auth.users table
    const metadata = nhostUser.metadata || {}; // Custom data passed from frontend signup

    // Helper function to make GraphQL requests to Hasura
    const graphqlRequest = async (query, variables) => {
        const response = await fetch(HASURA_GRAPHQL_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-hasura-admin-secret': HASURA_GRAPHQL_ADMIN_SECRET,
            },
            body: JSON.stringify({ query, variables }),
        });
        const result = await response.json();
        if (result.errors) {
            console.error('GraphQL Request Errors from function:', JSON.stringify(result.errors, null, 2));
            // Optionally, you might want to throw an error here to be caught by the main try-catch
        }
        return result;
    };

    // Helper to generate unique referral code
    async function generateUniqueUserReferralCode() {
        let referralCode = '';
        let isUnique = false;
        // GraphQL query to check if a referral code already exists in user_profiles
        const GET_USER_BY_REFERRAL_CODE = `
            query GetUserProfileByReferralCode($referralCode: String!) {
                user_profiles(where: {user_referral_code: {_eq: $referralCode}}) {
                    id
                }
            }
        `;
        while (!isUnique) {
            const randomNumber = Math.floor(100000 + Math.random() * 900000);
            referralCode = `edunexus-${randomNumber}`;
            try {
                const { data, errors: queryErrors } = await graphqlRequest(GET_USER_BY_REFERRAL_CODE, { referralCode });
                if (queryErrors) {
                    console.error("Error checking referral code uniqueness (GraphQL):", queryErrors);
                    throw new Error(queryErrors[0].message || "Failed to check referral code uniqueness");
                }
                if (!data || !data.user_profiles || data.user_profiles.length === 0) {
                    isUnique = true; // Code is unique
                }
            } catch (e) {
                console.error("Exception checking referral code uniqueness:", e);
                throw e; // Rethrow to be caught by the main try-catch block
            }
        }
        return referralCode;
    }
    
    let userReferralCode;
    try {
        userReferralCode = await generateUniqueUserReferralCode();
    } catch (e) {
        console.error("Failed to generate unique referral code in function:", e);
        return res.status(500).send("Failed to generate referral code due to internal error.");
    }

    // Determine name: use metadata if provided, otherwise Nhost's displayName, or fallback
    const name = (metadata.firstName && metadata.lastName) 
                 ? `${metadata.firstName} ${metadata.lastName}`.trim() 
                 : nhostUser.displayName || 'New User';

    const classStatus = metadata.class_status; // From frontend metadata
    const appRole = (classStatus === 'Teacher') ? 'teacher' : 'user'; // Set app_role based on class_status
    
    const farFutureDate = new Date();
    farFutureDate.setFullYear(farFutureDate.getFullYear() + 100); // For 'free' tier expiry

    // Prepare the object to insert into your public.user_profiles table
    const profileInput = {
        user_id: nhostUser.id, // Link to the auth.users record
        name: name,
        avatar_url: nhostUser.avatarUrl, // Nhost auth might populate this (e.g., from OAuth)
        phone: metadata.phone,
        class_status: metadata.class_status,
        target_exam: metadata.target_exam,
        target_exam_year: metadata.target_exam_year ? parseInt(metadata.target_exam_year, 10) : null,
        app_role: appRole,
        subscription_tier: 'free', // Default subscription tier
        subscription_expiry_date: farFutureDate.toISOString(), // Default expiry for free tier
        user_referral_code: userReferralCode, // Generated unique referral code
        referred_by_code: metadata.referred_by_code || null, // From frontend metadata
        referral_stats: { referred_free: 0, referred_chapterwise: 0, referred_full_length: 0, referred_dpp: 0, referred_combo: 0 },
        total_points: 0,
        // stripe_customer_id will be set later upon first payment if using Stripe
    };

    // GraphQL mutation to insert the new user profile
    const INSERT_USER_PROFILE_MUTATION = `
        mutation InsertUserProfile($object: user_profiles_insert_input!) {
            insert_user_profiles_one(object: $object) {
                id # Or other fields you want to return/log
                user_id
            }
        }
    `;

    try {
        console.log("Attempting to insert user profile with data:", JSON.stringify(profileInput, null, 2));
        const { data: insertData, errors: insertErrors } = await graphqlRequest(INSERT_USER_PROFILE_MUTATION, { object: profileInput });

        if (insertErrors) {
            console.error('Error inserting user profile into public.user_profiles:', JSON.stringify(insertErrors, null, 2));
            return res.status(400).send('Could not create user profile due to database error.');
        }
        if (!insertData || !insertData.insert_user_profiles_one) {
            console.error('User profile insert operation did not return expected data. Payload:', JSON.stringify(insertData, null, 2));
            return res.status(500).send('User profile creation might have failed or returned no data.');
        }

        console.log('User profile created successfully in public.user_profiles for auth.users.id:', nhostUser.id, 'Profile ID:', insertData.insert_user_profiles_one.id);
        return res.status(200).json({ success: true, profileId: insertData.insert_user_profiles_one.id });

    } catch (error) {
        console.error('Catch block: Unhandled error inserting user profile:', error);
        return res.status(500).send('Server error while creating user profile.');
    }
};