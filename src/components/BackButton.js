import React from 'react';

import { Link } from 'react-router';

const BackButton = React.createClass({
    render(){
        return (
            <Link to={this.props.to} className="title-bar__back">
                <svg width="13px" height="20px" viewBox="0 0 13 20" version="1.1" xmlns="http://www.w3.org/2000/svg">
                    <g id="turn" stroke="none" stroke-width="1" fill="none" fill-rule="evenodd">
                        <g id="iPhone-6" transform="translate(-10.000000, -36.000000)" fill="#FFFFFF">
                            <polygon id="circle-back-arrow-outline-stroke-path" points="19.9549999 36 22.4437508 38.4887491 14.9775 45.9549999 22.4437508 53.4212507 19.9549999 55.9099998 10 45.9549999"></polygon>
                        </g>
                    </g>
                </svg>
            </Link>
        )
    }
});

export default BackButton;
